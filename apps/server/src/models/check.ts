import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { getSecret } from '../vault.js';
import { fromLevels, type ModelInfo } from './caps.js';
import { chatGptAccessToken, connectionBaseUrl, setModelLevels } from './connections.js';
import { DATA_DIR } from '../paths.js';

// Does a model actually work on this account? (docs/model-connections.md)
// A model list says what a provider has, not what this key may use: retired
// models, models a free plan allows no requests to, models needing terms
// accepted. So when a model is picked for an agent, it gets one tiny request
// carrying a test tool, and the answer is kept. A failure flags the agent's
// card with the reason in plain words. For OpenAI, whose list says nothing
// about effort, the same check reads the exact levels from the API.

export type Check = {
  ok: boolean; // false: this model can't run an agent on this account
  reason?: string; // why not, in plain words
  unsure?: boolean; // the check itself didn't get an answer (busy, timeout); try again later
  at: number;
};

const FILE = join(DATA_DIR, 'model-checks.json');
const FRESH_MS = 12 * 60 * 60_000; // a result is trusted this long
const UNSURE_MS = 10 * 60_000; // an unsure one is retried after this

async function readAll(): Promise<Record<string, Check>> {
  try {
    return JSON.parse(await readFile(FILE, 'utf8')) as Record<string, Check>;
  } catch {
    return {};
  }
}
let writing = Promise.resolve();
function save(key: string, check: Check) {
  writing = writing.then(async () => {
    const all = await readAll();
    all[key] = check;
    await mkdir(dirname(FILE), { recursive: true });
    await writeFile(FILE, JSON.stringify(all, null, 2) + '\n');
  });
  return writing;
}

export const allChecks = readAll;
const keyOf = (connection: string, model: string) => `${connection}/${model}`;

// Checks a model, unless a recent answer is kept (force: check again anyway).
const inFlight = new Map<string, Promise<Check>>();
export async function checkModel(connection: string, model: string, force = false): Promise<Check> {
  const key = keyOf(connection, model);
  const kept = (await readAll())[key];
  if (kept && !force && Date.now() - kept.at < (kept.unsure ? UNSURE_MS : FRESH_MS)) return kept;
  const running = inFlight.get(key);
  if (running) return running;
  const p = (async () => {
    let check: Check;
    try {
      check = await probe(connection, model);
    } catch (e) {
      check = { ok: true, unsure: true, reason: `Couldn't check: ${(e as Error).message}`, at: Date.now() };
    }
    await save(key, check);
    return check;
  })().finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

// --- What a provider's answer means -------------------------------------------

type Answer = { status: number; message: string; headers?: Headers };

// A failed request, in plain words. unsure: the provider didn't really answer
// (busy, down, timed out), so the model isn't flagged.
export function classify(a: Answer): { reason: string; unsure?: boolean } {
  // Lower case, without the quotes and backticks providers wrap names in.
  const m = a.message.toLowerCase().replace(/[`'"]/g, '');
  if (a.status === 0) return { reason: "Couldn't reach the provider", unsure: true };
  // Not "billing": Gemini's quota errors say "check your plan and billing details".
  if (/insufficient (balance|credits?|funds)|out of credits|no credits|payment required/.test(m) || a.status === 402)
    return { reason: 'No credit left on this account' };
  if (/not allowed on chat completions|not supported with the responses api/.test(m)) return { reason: "Can't run agents" };
  if (/terms acceptance|accept the terms/.test(m)) return { reason: "Needs the provider's terms accepted first" };
  if (/function calling is not enabled|tool calling is not supported|tools? (are|is) not supported|does not support tools/.test(m))
    return { reason: "Can't use tools" };
  if (/labs model|not enabled|enable them|not available on your plan/.test(m)) return { reason: 'Not enabled for this account' };
  if (/no longer available|does not exist|not found|deprecated|decommissioned|retired|invalid model|not supported with the responses api|is a video model|is an image model/.test(m) || a.status === 404)
    return { reason: 'No longer available' };
  if (a.status === 429) {
    // A plan that allows no requests at all isn't "busy".
    const limit = a.headers?.get('x-ratelimit-limit-req-minute') ?? a.headers?.get('x-ratelimit-limit-requests');
    if (limit === '0' || /limit: 0\b/.test(m)) return { reason: 'Not available on your plan' };
    if (/quota/.test(m)) return { reason: "Hit this account's usage limit for now", unsure: true };
    return { reason: 'The provider is busy', unsure: true };
  }
  if (a.status === 401 || a.status === 403) return { reason: "The key wasn't accepted" };
  if (a.status >= 500) return { reason: 'The provider had a problem', unsure: true };
  return { reason: a.message.slice(0, 120) || `Error ${a.status}` };
}

// OpenAI names the levels a model takes when it's sent one it doesn't.
export function levelsFromError(message: string): string[] | null {
  const m = message.match(/supported values are:? (.+)$/i);
  return m ? [...m[1].matchAll(/'([a-z]+)'/gi)].map(x => x[1].toLowerCase()) : null;
}

// --- The test request, per provider ---------------------------------------------

const PROMPT = 'Reply with ok.';
const TOOL = { name: 'check_weather', description: 'Weather for a city', schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } };

// timeoutMs: a local model is loaded from disk on its first request, which on
// a 16 GB laptop took 35 s for gpt-oss:20b - so local checks wait longer.
async function send(url: string, headers: Record<string, string>, body: unknown, timeoutMs = 60_000): Promise<Answer> {
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    if (res.ok) {
      // A streamed reply can still fail partway (ChatGPT plan).
      const failed = text.match(/"type":"response\.failed"[\s\S]*?"message":"([^"]+)"/);
      return failed ? { status: 400, message: failed[1], headers: res.headers } : { status: res.status, message: '', headers: res.headers };
    }
    let message = text;
    try {
      const j = JSON.parse(text) as { error?: { message?: string } | string; message?: string; detail?: unknown };
      message = (typeof j.error === 'string' ? j.error : j.error?.message) ?? j.message ?? (j.detail ? JSON.stringify(j.detail) : text);
    } catch {}
    return { status: res.status, message: String(message).replace(/\s+/g, ' ').trim(), headers: res.headers };
  } catch (e) {
    return { status: 0, message: (e as Error).message };
  }
}

const OPENAI_COMPATIBLE: Record<string, string> = {
  openrouter: 'https://openrouter.ai/api/v1',
  xai: 'https://api.x.ai/v1',
  mistral: 'https://api.mistral.ai/v1',
  deepseek: 'https://api.deepseek.com',
  groq: 'https://api.groq.com/openai/v1',
};
const chatTool = { type: 'function', function: { name: TOOL.name, description: TOOL.description, parameters: TOOL.schema } };
const responsesTool = { type: 'function', name: TOOL.name, description: TOOL.description, parameters: TOOL.schema };
const key = async (id: string) => (await getSecret<{ key: string }>(id))?.key ?? '';

// One short prompt through Claude Code, started the way an agent's run starts it.
async function probeClaudeCode(model: string): Promise<Check> {
  const { claudeOnce } = await import('../runner/harness.js');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 120_000);
  try {
    const out = await claudeOnce(['-p', '--output-format', 'json', '--model', model, '--max-turns', '1', '--tools', '', '--setting-sources', ''], PROMPT, tmpdir(), ctrl.signal);
    if (out.is_error) return { ok: false, reason: (out.result || out.subtype || 'Claude Code answered with an error').slice(0, 200), at: Date.now() };
    return { ok: true, at: Date.now() };
  } catch (e) {
    return { ok: false, reason: ctrl.signal.aborted ? "Claude Code didn't answer within two minutes." : (e as Error).message.slice(0, 200), at: Date.now() };
  } finally {
    clearTimeout(timer);
  }
}

// One short prompt through Copilot's runtime (fetched first if this install
// hasn't got it), in a session like a run's: model auto, none of its own tools.
async function probeCopilot(model: string): Promise<Check> {
  const token = (await getSecret<{ token: string }>('copilot'))?.token;
  if (!token) return { ok: false, reason: 'Copilot is not signed in.', at: Date.now() };
  const { CopilotClient, ToolSet, approveAll } = await import('@github/copilot-sdk');
  const { copilotConnection } = await import('./copilotRuntime.js');
  const client = new CopilotClient({ ...(await copilotConnection()), gitHubToken: token, useLoggedInUser: false, logLevel: 'error' });
  try {
    await client.start();
    const session = await client.createSession({ model, workingDirectory: tmpdir(), availableTools: new ToolSet().addCustom('*'), onPermissionRequest: approveAll });
    await session.sendAndWait({ prompt: PROMPT }, 120_000);
    await session.disconnect().catch(() => {});
    return { ok: true, at: Date.now() };
  } catch (e) {
    return { ok: false, reason: (e as Error).message.slice(0, 200), at: Date.now() };
  } finally {
    await client.stop().catch(() => {});
  }
}

async function probe(connection: string, model: string): Promise<Check> {
  const done = (a: Answer): Check => (a.status >= 200 && a.status < 300 ? { ok: true, at: Date.now() } : { ok: false, ...classify(a), at: Date.now() });
  const unsureToOk = (c: Check): Check => (c.unsure ? { ...c, ok: true } : c);

  switch (connection) {
    // Plans: a real answer through the same program runs use, since signed in
    // isn't the same as working (Claude Code installed while the app was open,
    // say, or Copilot's runtime not there).
    case 'claude-code':
      return probeClaudeCode(model);
    case 'copilot':
      return probeCopilot(model);
    case 'anthropic':
      return unsureToOk(
        done(
          await send('https://api.anthropic.com/v1/messages', { 'x-api-key': await key('anthropic'), 'anthropic-version': '2023-06-01' }, {
            model,
            max_tokens: 16,
            messages: [{ role: 'user', content: PROMPT }],
            tools: [{ name: TOOL.name, description: TOOL.description, input_schema: TOOL.schema }],
          }),
        ),
      );
    case 'google':
      return unsureToOk(
        done(
          await send(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, { 'x-goog-api-key': await key('google') }, {
            contents: [{ role: 'user', parts: [{ text: PROMPT }] }],
            tools: [{ functionDeclarations: [{ name: TOOL.name, description: TOOL.description, parameters: TOOL.schema }] }],
            generationConfig: { maxOutputTokens: 16 },
          }),
        ),
      );
    case 'chatgpt':
      return unsureToOk(
        done(
          await send('https://api.openai.com/v1/responses', { authorization: `Bearer ${await chatGptAccessToken()}` }, {
            model,
            input: [{ role: 'user', content: [{ type: 'input_text', text: PROMPT }] }],
            tools: [responsesTool],
            store: false,
            stream: true,
          }),
        ),
      );
    case 'openai':
      return unsureToOk(await probeOpenAi(model));
    case 'ollama': {
      const base = ((await connectionBaseUrl('ollama')) || 'http://localhost:11434').replace(/\/+$/, '');
      return unsureToOk(done(await send(`${base}/api/chat`, {}, { model, stream: false, messages: [{ role: 'user', content: PROMPT }], tools: [chatTool], options: { num_predict: 16 } }, 300_000)));
    }
    default: {
      const base = OPENAI_COMPATIBLE[connection] ?? (connection === 'custom' ? (await connectionBaseUrl('custom'))?.replace(/\/+$/, '') : undefined);
      if (!base) return { ok: false, reason: 'Unknown connection', at: Date.now() };
      return unsureToOk(
        done(await send(`${base}/chat/completions`, { authorization: `Bearer ${await key(connection)}` }, { model, max_tokens: 16, messages: [{ role: 'user', content: PROMPT }], tools: [chatTool] })),
      );
    }
  }
}

// OpenAI: ask for effort "none". A model that doesn't take it says which
// levels it does (rejected requests aren't billed); one without effort says
// the parameter isn't supported. Then one real request confirms access and
// tools at a level it takes. The levels found replace the known table's.
async function probeOpenAi(model: string): Promise<Check> {
  const auth = { authorization: `Bearer ${await key('openai')}` };
  const ask = (effort?: string) =>
    send('https://api.openai.com/v1/responses', auth, {
      model,
      input: PROMPT,
      tools: [responsesTool],
      max_output_tokens: 16,
      store: false,
      ...(effort ? { reasoning: { effort } } : {}),
    });
  const done = (a: Answer): Check => (a.status >= 200 && a.status < 300 ? { ok: true, at: Date.now() } : { ok: false, ...classify(a), at: Date.now() });

  const first = await ask('none');
  let levels: string[] | null = null;
  let final: Answer;
  if (first.status === 200) {
    // Takes "none": its full list comes from a level it may not take.
    final = first;
    const second = await ask('minimal');
    levels = second.status === 200 ? null : levelsFromError(second.message);
  } else if ((levels = levelsFromError(first.message))) {
    final = await ask(levels.find(l => l !== 'none' && l !== 'minimal') ?? levels[0]);
  } else if (/unsupported parameter: 'reasoning/i.test(first.message)) {
    levels = [];
    final = await ask();
  } else final = first;

  const check = done(final);
  if (check.ok && levels) await setModelLevels('openai', { id: model, ...fromLevels(levels) } as ModelInfo);
  return check;
}
