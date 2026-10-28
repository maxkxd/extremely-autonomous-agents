import Anthropic from '@anthropic-ai/sdk';
import { getSecret } from '../vault.js';
import { chatGptAccessToken, connectionBaseUrl } from '../models/connections.js';

// One tool loop, every provider (docs/runner.md). A run keeps its conversation
// in a neutral shape; each adapter translates it to and from its provider.
// A provider's own turns are replayed exactly as it sent them (Anthropic's
// thinking blocks, Gemini's thought signatures, DeepSeek's reasoning_content,
// OpenAI's reasoning items) - providers reject or degrade without them. A run
// that moves to its next model mid-way carries on from the neutral shape, so
// no action is ever re-sent.

export type ToolSpec = { name: string; description: string; schema: Record<string, unknown> };
export type Call = { id: string; name: string; args: Record<string, unknown> };
export type Raw = { provider: string; data: unknown };
export type Msg =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string; calls: Call[]; raw?: Raw }
  | { role: 'tool'; results: { id: string; name: string; content: string; error?: boolean }[] };

export type TurnRequest = {
  connection: string;
  model: string;
  effort?: string; // the provider's own level name, or none
  system: string;
  messages: Msg[];
  tools: ToolSpec[];
  maxTokens?: number;
  signal?: AbortSignal;
};
export type Usage = { input: number; output: number };
export type TurnResult = { text: string; calls: Call[]; raw?: Raw; usage: Usage; truncated?: boolean };

// kind: why a model call failed, which decides what the runner does next.
//   rate   - busy or out of quota: bench it, try the next model
//   auth   - key or sign-in no longer works
//   server - the provider had a problem
//   bad    - it refused what we sent (a provider quirk): try the next model
//   network- couldn't reach it
export class ModelError extends Error {
  constructor(
    message: string,
    public kind: 'rate' | 'auth' | 'server' | 'bad' | 'network',
    public status = 0,
  ) {
    super(message);
  }
}

const MAX_TOKENS = 16_000;

export type Adapter = (req: TurnRequest) => Promise<TurnResult>;

// Which adapter speaks for a connection.
export function adapterFor(connection: string): Adapter | null {
  switch (connection) {
    case 'anthropic':
      return anthropicTurn;
    case 'openai':
    case 'chatgpt':
      return responsesTurn;
    case 'google':
      return geminiTurn;
    case 'ollama':
      return ollamaTurn;
    case 'openrouter':
    case 'xai':
    case 'groq':
    case 'mistral':
    case 'deepseek':
    case 'custom':
      return chatTurn;
    default:
      return null; // claude-code and copilot run through their own harness
  }
}

const key = async (id: string) => {
  const k = (await getSecret<{ key: string }>(id))?.key;
  if (!k) throw new ModelError(`${id} has no key saved`, 'auth');
  return k;
};

function fail(status: number, message: string): never {
  const m = message.replace(/\s+/g, ' ').slice(0, 300);
  if (status === 429) throw new ModelError(m, 'rate', status);
  if (status === 401 || status === 403) throw new ModelError(m, 'auth', status);
  if (status >= 500 || status === 529) throw new ModelError(m, 'server', status);
  throw new ModelError(m, 'bad', status);
}

async function postJson(url: string, headers: Record<string, string>, body: unknown, signal?: AbortSignal, timeoutMs = 300_000) {
  let res: Response;
  try {
    const timeout = AbortSignal.timeout(timeoutMs);
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch (e) {
    throw new ModelError(`Couldn't reach ${new URL(url).host}: ${(e as Error).message}`, 'network');
  }
  const text = await res.text();
  if (!res.ok) {
    let message = text;
    try {
      const j = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
      message = (typeof j.error === 'string' ? j.error : j.error?.message) ?? j.message ?? text;
    } catch {}
    fail(res.status, String(message));
  }
  return text;
}

const parseArgs = (s: unknown): Record<string, unknown> => {
  if (s && typeof s === 'object') return s as Record<string, unknown>;
  try {
    const v = JSON.parse(String(s || '{}'));
    return v && typeof v === 'object' ? v : { value: v };
  } catch {
    return { _unparsed: String(s) };
  }
};
let idSeq = 0;
const newId = () => `call_${Date.now().toString(36)}${(idSeq++).toString(36)}`;
// Some providers only take [a-zA-Z0-9_-] ids.
const cleanId = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || newId();

// --- Anthropic ----------------------------------------------------------------

// Models that rejected adaptive thinking; they run with effort alone.
const noAdaptive = new Set<string>();

async function anthropicTurn(req: TurnRequest): Promise<TurnResult> {
  const client = new Anthropic({ apiKey: await key('anthropic'), maxRetries: 0 });
  const messages: Anthropic.MessageParam[] = [];
  const push = (role: 'user' | 'assistant', blocks: Anthropic.ContentBlockParam[]) => {
    const last = messages[messages.length - 1];
    if (last && last.role === role && Array.isArray(last.content)) last.content.push(...blocks);
    else messages.push({ role, content: blocks });
  };
  for (const m of req.messages) {
    if (m.role === 'user') push('user', [{ type: 'text', text: m.text }]);
    else if (m.role === 'tool')
      push(
        'user',
        m.results.map(r => ({ type: 'tool_result' as const, tool_use_id: cleanId(r.id), content: r.content, is_error: r.error || undefined })),
      );
    else if (m.raw?.provider === 'anthropic') push('assistant', m.raw.data as Anthropic.ContentBlockParam[]);
    else
      push('assistant', [
        ...(m.text ? [{ type: 'text' as const, text: m.text }] : []),
        ...m.calls.map(c => ({ type: 'tool_use' as const, id: cleanId(c.id), name: c.name, input: c.args })),
      ]);
  }
  const params: Anthropic.MessageCreateParamsNonStreaming = {
    model: req.model,
    max_tokens: req.maxTokens ?? MAX_TOKENS,
    system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
    messages,
    tools: req.tools.map(t => ({ name: t.name, description: t.description, input_schema: t.schema as Anthropic.Tool.InputSchema })),
  };
  if (req.effort) {
    params.output_config = { effort: req.effort as 'low' };
    if (!noAdaptive.has(req.model)) params.thinking = { type: 'adaptive' };
  }
  let msg: Anthropic.Message;
  try {
    msg = await client.messages.stream(params, { signal: req.signal }).finalMessage();
  } catch (e) {
    const err = e as { status?: number; message?: string };
    // A model without adaptive thinking: once more with effort alone.
    if (err.status === 400 && params.thinking && /thinking/i.test(err.message ?? '')) {
      noAdaptive.add(req.model);
      return anthropicTurn(req);
    }
    if (err.status) fail(err.status, err.message ?? 'Anthropic error');
    throw new ModelError(err.message ?? 'Anthropic error', 'network');
  }
  const text = msg.content.flatMap(b => (b.type === 'text' ? [b.text] : [])).join('');
  const calls = msg.content.flatMap(b => (b.type === 'tool_use' ? [{ id: b.id, name: b.name, args: (b.input ?? {}) as Record<string, unknown> }] : []));
  return {
    text,
    calls,
    raw: { provider: 'anthropic', data: msg.content },
    usage: {
      input: msg.usage.input_tokens + (msg.usage.cache_read_input_tokens ?? 0) + (msg.usage.cache_creation_input_tokens ?? 0),
      output: msg.usage.output_tokens,
    },
    truncated: msg.stop_reason === 'max_tokens',
  };
}

// --- OpenAI Responses (API key, and Sign in with ChatGPT) ----------------------

type RespItem = Record<string, unknown> & { type?: string };

async function responsesTurn(req: TurnRequest): Promise<TurnResult> {
  const plan = req.connection === 'chatgpt';
  const token = plan ? await chatGptAccessToken() : await key('openai');
  const input: RespItem[] = [];
  for (const m of req.messages) {
    if (m.role === 'user') input.push({ role: 'user', content: [{ type: 'input_text', text: m.text }] });
    else if (m.role === 'tool') for (const r of m.results) input.push({ type: 'function_call_output', call_id: r.id, output: r.content });
    else if (m.raw?.provider === req.connection) input.push(...(m.raw.data as RespItem[]));
    else {
      if (m.text) input.push({ role: 'assistant', content: [{ type: 'output_text', text: m.text }] });
      for (const c of m.calls) input.push({ type: 'function_call', call_id: c.id, name: c.name, arguments: JSON.stringify(c.args) });
    }
  }
  const body: Record<string, unknown> = {
    model: req.model,
    instructions: req.system,
    input,
    tools: req.tools.map(t => ({ type: 'function', name: t.name, description: t.description, parameters: t.schema, strict: false })),
    store: false,
    // Reasoning items come back encrypted, so they can be replayed with store off.
    include: ['reasoning.encrypted_content'],
  };
  if (req.effort) body.reasoning = { effort: req.effort };
  if (!plan) body.max_output_tokens = req.maxTokens ?? MAX_TOKENS;
  if (plan) body.stream = true; // the plan only answers streamed
  const text = await postJson('https://api.openai.com/v1/responses', { authorization: `Bearer ${token}` }, body, req.signal);

  let resp: { output?: RespItem[]; usage?: { input_tokens?: number; output_tokens?: number }; status?: string; incomplete_details?: { reason?: string } };
  if (plan) {
    const events = text
      .split('\n')
      .filter(l => l.startsWith('data:'))
      .map(l => l.slice(5).trim())
      .filter(l => l && l !== '[DONE]')
      .map(l => JSON.parse(l) as { type: string; response?: typeof resp & { error?: { message?: string } } });
    const end = events.find(e => e.type === 'response.completed' || e.type === 'response.failed' || e.type === 'response.incomplete');
    if (!end?.response) throw new ModelError('ChatGPT sent no complete response', 'server');
    if (end.type === 'response.failed') {
      const m = end.response.error?.message ?? 'ChatGPT run failed';
      throw new ModelError(m, /limit|quota|usage/i.test(m) ? 'rate' : 'server');
    }
    resp = end.response;
  } else resp = JSON.parse(text);

  const output = resp.output ?? [];
  const outText = output
    .filter(o => o.type === 'message')
    .flatMap(o => (o.content as { type: string; text?: string }[]) ?? [])
    .filter(c => c.type === 'output_text')
    .map(c => c.text ?? '')
    .join('');
  const calls = output
    .filter(o => o.type === 'function_call')
    .map(o => ({ id: String(o.call_id), name: String(o.name), args: parseArgs(o.arguments) }));
  return {
    text: outText,
    calls,
    raw: { provider: req.connection, data: output },
    usage: { input: resp.usage?.input_tokens ?? 0, output: resp.usage?.output_tokens ?? 0 },
    truncated: resp.status === 'incomplete' && resp.incomplete_details?.reason === 'max_output_tokens',
  };
}

// --- OpenAI-compatible chat completions -----------------------------------------

const CHAT_BASE: Record<string, string> = {
  openrouter: 'https://openrouter.ai/api/v1',
  xai: 'https://api.x.ai/v1',
  groq: 'https://api.groq.com/openai/v1',
  mistral: 'https://api.mistral.ai/v1',
  deepseek: 'https://api.deepseek.com',
};

// Mistral only takes 9-character alphanumeric tool call ids.
function mistralId(id: string) {
  if (/^[a-zA-Z0-9]{9}$/.test(id)) return id;
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h.toString(36).padStart(9, '0').slice(-9);
}

type ChatMessage = {
  role: string;
  content: string | null;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
  reasoning_content?: string;
  reasoning_details?: unknown;
};

async function chatTurn(req: TurnRequest): Promise<TurnResult> {
  const base = CHAT_BASE[req.connection] ?? (await connectionBaseUrl('custom'))?.replace(/\/+$/, '');
  if (!base) throw new ModelError('No base URL for this connection', 'bad');
  const ids = req.connection === 'mistral' ? mistralId : (id: string) => id;
  const messages: ChatMessage[] = [{ role: 'system', content: req.system }];
  for (const m of req.messages) {
    if (m.role === 'user') messages.push({ role: 'user', content: m.text });
    else if (m.role === 'tool') for (const r of m.results) messages.push({ role: 'tool', tool_call_id: ids(r.id), content: r.content });
    else {
      const own = m.raw?.provider === req.connection ? (m.raw.data as ChatMessage) : null;
      messages.push({
        role: 'assistant',
        content: m.text || null,
        ...(m.calls.length
          ? { tool_calls: m.calls.map(c => ({ id: ids(c.id), type: 'function' as const, function: { name: c.name, arguments: JSON.stringify(c.args) } })) }
          : {}),
        // DeepSeek requires its reasoning back on every later request when tools
        // are used - and an empty one for turns another model made (tested).
        ...(own?.reasoning_content
          ? { reasoning_content: own.reasoning_content }
          : req.connection === 'deepseek' && m.calls.length
            ? { reasoning_content: '' }
            : {}),
        ...(own?.reasoning_details ? { reasoning_details: own.reasoning_details } : {}),
      });
    }
  }
  const body: Record<string, unknown> = {
    model: req.model,
    messages,
    tools: req.tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.schema } })),
    max_tokens: req.maxTokens ?? MAX_TOKENS,
  };
  if (req.effort) {
    if (req.connection === 'openrouter') body.reasoning = { effort: req.effort };
    else body.reasoning_effort = req.effort;
  }
  const text = await postJson(`${base}/chat/completions`, { authorization: `Bearer ${await key(req.connection)}` }, body, req.signal);
  const j = JSON.parse(text) as {
    choices?: { message?: ChatMessage; finish_reason?: string }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
    error?: { message?: string };
  };
  // OpenRouter can answer 200 with an error inside.
  if (j.error) throw new ModelError(j.error.message ?? 'Provider error', 'server');
  const choice = j.choices?.[0];
  const msg = choice?.message ?? { role: 'assistant', content: '' };
  const calls = (msg.tool_calls ?? []).map(c => ({ id: c.id || newId(), name: c.function.name, args: parseArgs(c.function.arguments) }));
  return {
    text: msg.content ?? '',
    calls,
    raw: { provider: req.connection, data: msg },
    usage: { input: j.usage?.prompt_tokens ?? 0, output: j.usage?.completion_tokens ?? 0 },
    truncated: choice?.finish_reason === 'length',
  };
}

// --- Gemini ---------------------------------------------------------------------

type Part = Record<string, unknown>;
// Gemini models that don't take a thinking level; a budget is used instead.
const budgetOnly = new Set<string>();
const BUDGET: Record<string, number> = { low: 1024, medium: 4096, high: 16_384 };

async function geminiTurn(req: TurnRequest): Promise<TurnResult> {
  const contents: { role: string; parts: Part[] }[] = [];
  const names = new Map<string, string>(); // call id -> name, for function responses
  for (const m of req.messages) {
    if (m.role === 'user') contents.push({ role: 'user', parts: [{ text: m.text }] });
    else if (m.role === 'tool')
      contents.push({
        role: 'user',
        parts: m.results.map(r => ({ functionResponse: { name: names.get(r.id) ?? r.name, response: { content: r.content, error: r.error || undefined } } })),
      });
    else {
      for (const c of m.calls) names.set(c.id, c.name);
      if (m.raw?.provider === 'google') contents.push({ role: 'model', parts: m.raw.data as Part[] });
      else
        contents.push({
          role: 'model',
          parts: [
            ...(m.text ? [{ text: m.text }] : []),
            // Gemini requires a thought signature on every earlier call; for calls
            // another model made, Google's documented placeholder skips the check.
            ...m.calls.map(c => ({ functionCall: { name: c.name, args: c.args }, thoughtSignature: 'skip_thought_signature_validator' })),
          ],
        });
    }
  }
  const generationConfig: Record<string, unknown> = { maxOutputTokens: req.maxTokens ?? MAX_TOKENS };
  if (req.effort)
    generationConfig.thinkingConfig = budgetOnly.has(req.model) ? { thinkingBudget: BUDGET[req.effort] ?? 4096 } : { thinkingLevel: req.effort };
  const body = {
    systemInstruction: { parts: [{ text: req.system }] },
    contents,
    tools: [{ functionDeclarations: req.tools.map(t => ({ name: t.name, description: t.description, parametersJsonSchema: t.schema })) }],
    generationConfig,
  };
  let text: string;
  try {
    text = await postJson(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(req.model)}:generateContent`,
      { 'x-goog-api-key': await key('google') },
      body,
      req.signal,
    );
  } catch (e) {
    if (e instanceof ModelError && e.kind === 'bad' && /thinking level/i.test(e.message) && !budgetOnly.has(req.model)) {
      budgetOnly.add(req.model);
      return geminiTurn(req);
    }
    throw e;
  }
  const j = JSON.parse(text) as {
    candidates?: { content?: { parts?: Part[] }; finishReason?: string }[];
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
  };
  const cand = j.candidates?.[0];
  const parts = cand?.content?.parts ?? [];
  const calls = parts
    .filter(p => p.functionCall)
    .map(p => {
      const fc = p.functionCall as { id?: string; name: string; args?: Record<string, unknown> };
      return { id: fc.id ?? newId(), name: fc.name, args: fc.args ?? {} };
    });
  return {
    text: parts
      .filter(p => typeof p.text === 'string' && !p.thought)
      .map(p => p.text as string)
      .join(''),
    calls,
    raw: { provider: 'google', data: parts },
    usage: {
      input: j.usageMetadata?.promptTokenCount ?? 0,
      output: (j.usageMetadata?.candidatesTokenCount ?? 0) + (j.usageMetadata?.thoughtsTokenCount ?? 0),
    },
    truncated: cand?.finishReason === 'MAX_TOKENS',
  };
}

// --- Ollama ---------------------------------------------------------------------

async function ollamaTurn(req: TurnRequest): Promise<TurnResult> {
  const base = ((await connectionBaseUrl('ollama')) || 'http://localhost:11434').replace(/\/+$/, '');
  const messages: Record<string, unknown>[] = [{ role: 'system', content: req.system }];
  for (const m of req.messages) {
    if (m.role === 'user') messages.push({ role: 'user', content: m.text });
    else if (m.role === 'tool') for (const r of m.results) messages.push({ role: 'tool', content: r.content, tool_name: r.name });
    else
      messages.push({
        role: 'assistant',
        content: m.text,
        tool_calls: m.calls.map(c => ({ function: { name: c.name, arguments: c.args } })),
      });
  }
  const body: Record<string, unknown> = {
    model: req.model,
    messages,
    tools: req.tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.schema } })),
    stream: false,
    // Agents need room: the default 4k context would cut off their instructions.
    options: { num_ctx: 16_384, num_predict: req.maxTokens ?? MAX_TOKENS },
  };
  if (req.effort) body.think = req.effort;
  // A local model loads from disk on its first request: allow it time.
  const text = await postJson(`${base}/api/chat`, {}, body, req.signal, 600_000);
  const j = JSON.parse(text) as {
    message?: { content?: string; tool_calls?: { function: { name: string; arguments: unknown } }[] };
    prompt_eval_count?: number;
    eval_count?: number;
    done_reason?: string;
  };
  return {
    text: j.message?.content ?? '',
    calls: (j.message?.tool_calls ?? []).map(c => ({ id: newId(), name: c.function.name, args: parseArgs(c.function.arguments) })),
    usage: { input: j.prompt_eval_count ?? 0, output: j.eval_count ?? 0 },
    truncated: j.done_reason === 'length',
  };
}
