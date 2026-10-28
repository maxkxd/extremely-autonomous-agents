import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import * as z from 'zod/v4';
import { catalogForPrompt } from './catalog.js';

// The agent builder (docs/agent-creation.md): one conversation that turns a
// person's description into a Charter, TOOLS.yaml and KPI.yaml.

const client = new Anthropic();
const MODEL = 'claude-opus-5-5';
// On a policy decline, rerun the request on Anthropic's recommended fallback
// model instead of returning the refusal.
const FALLBACK = { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const };

export type Pack = { id: string; name: string; tagline: string; agents: { name: string; does: string }[] };
export type Turn = { role: 'person' | 'builder'; text: string };

export class BuilderError extends Error {}

const ABOUT = `You are the agent builder in Extremely Autonomous Agents, an app where a person runs a fleet of autonomous AI agents. Each agent runs on its own schedule, uses tools, and asks a person only when it must.

Every agent is defined by three files the person never sees:
- CHARTER.md: its mission, what it does and doesn't do, its guardrails, when it asks a person, and what a good run looks like.
- TOOLS.yaml: the tools it may call, each with a tier:
  T0 - just runs (reads, research, its own scratch documents).
  T1 - runs, and posts a notice to the agent's own channel (reversible internal writes: records, drafts, labels, notes).
  T2 - waits for a person's approval and expires if nobody decides (anything visible outside the organisation or hard to undo: sending, posting, publishing, paying, deleting, inviting).
  A tool that isn't listed can't be called, so there is no "never" tier.
- KPI.yaml: which successful actions count as its output.

How agents work with people, which every agent must respect:
- An agent asks a person for things through Requests (a key, an account, spend, a decision) and Approvals (a T2 action). It never expects anyone to read its own channel.
- How hard an agent works is set separately by the person (its ferocity), so don't ask about cadence beyond what the job itself needs (e.g. "within an hour of a ticket arriving" is a job requirement; "run more" isn't).
- API keys and passwords are added later in settings. Never ask for them and tell the person not to paste them into the chat.

The tool catalogue (server.tool [default tier] what it does):

${catalogForPrompt()}

Every agent also gets fleet plumbing automatically: its task list, Requests, memory proposals, booking its own follow-up run, and its own channel. Never ask about those.
When nothing in the catalogue does a job, you define a new tool yourself and it gets built; the person doesn't have to arrange anything.`;

// Stable across every call, so it's cached.
const system = (task: string): Anthropic.Beta.BetaTextBlockParam[] => [
  { type: 'text', text: ABOUT, cache_control: { type: 'ephemeral' } },
  { type: 'text', text: task },
];

function transcript(turns: Turn[]): Anthropic.Beta.BetaMessageParam[] {
  return turns.map(t => ({ role: t.role === 'person' ? 'user' : 'assistant', content: t.text }));
}

async function parse<T extends z.ZodType>(
  schema: T,
  task: string,
  messages: Anthropic.Beta.BetaMessageParam[],
  effort: 'low' | 'medium' | 'high',
): Promise<z.infer<T>> {
  try {
    const res = await client.beta.messages.parse({
      model: MODEL,
      max_tokens: 16000,
      system: system(task),
      messages,
      output_config: { effort, format: zodOutputFormat(schema) },
      ...FALLBACK,
    });
    if (res.stop_reason === 'refusal') throw new BuilderError('Claude declined this one. Try rewording it.');
    if (res.stop_reason === 'max_tokens') throw new BuilderError('The reply was cut off. Try again.');
    if (!res.parsed_output) throw new BuilderError('The builder gave a reply it could not read. Try again.');
    return res.parsed_output;
  } catch (e) {
    if (e instanceof BuilderError) throw e;
    if (e instanceof Anthropic.AuthenticationError) throw new BuilderError('No valid Anthropic API key. Add ANTHROPIC_API_KEY to apps/server/.env and restart the server.');
    if (e instanceof Anthropic.RateLimitError) throw new BuilderError('Rate limited by the Claude API. Wait a moment and try again.');
    if (e instanceof Anthropic.APIConnectionError) throw new BuilderError('Could not reach the Claude API.');
    if (e instanceof Anthropic.APIError) throw new BuilderError(`Claude API error (${e.status}).`);
    // No credentials at all: the SDK throws before any request.
    if (e instanceof Error && /api ?key|auth/i.test(e.message)) throw new BuilderError('No Anthropic API key. Add ANTHROPIC_API_KEY to apps/server/.env and restart the server.');
    throw e;
  }
}

// --- 1. Is there a pack for this already? (asked at most once) ---

const MatchSchema = z.object({
  pack_id: z.string().nullable().describe('The id of the pack that genuinely covers it, or null'),
  reason: z.string().describe('One short sentence to the person on why this pack fits. Empty when pack_id is null.'),
});

export async function matchPack(description: string, packs: Pack[]) {
  const list = packs
    .map(p => `- id: ${p.id} | ${p.name}: ${p.tagline}\n` + p.agents.map(a => `    - ${a.name}: ${a.does}`).join('\n'))
    .join('\n');
  const out = await parse(
    MatchSchema,
    `Right now your only job: decide whether one of these ready-made packs already covers what the person described. Recommend a pack only when its agents would genuinely do the job; when it's merely in the same area, or the description has a specific twist the pack doesn't cover, return null. Address the reason to the person ("you").\n\nPacks:\n${list}`,
    [{ role: 'user', content: description }],
    'low',
  );
  return packs.some(p => p.id === out.pack_id) ? out : { pack_id: null, reason: '' };
}

// --- 2. The interview ---

const TurnSchema = z.object({
  reply: z.string().describe('Your next message to the person'),
  confidence: z
    .number()
    .describe('0-100: how sure you are that you understand this agent well enough to write its Charter and tools'),
  ready: z.boolean().describe('True when you have what you need and are not asking anything in this reply'),
});

export async function interview(turns: Turn[], declinedPack: string | null) {
  const declined = declinedPack
    ? `\n\nEarlier you recommended the ready-made "${declinedPack}" pack and the person carried on instead, so what they want is different. If it isn't obvious how, you may ask once. Never recommend a pack again.`
    : '';
  return parse(
    TurnSchema,
    `You are now interviewing the person so you can write their agent. Each reply:
- Ask only what you genuinely can't work out or sensibly default yourself: which systems it works in (when it matters which), where its work goes, what it must never do, what needs their OK before it happens, what "done well" looks like. Make sensible assumptions about the rest and say what you assumed in a few words.
- One or two short questions at a time, in plain words, no jargon (never say T0/T1/T2, Charter or YAML).
- Keep it short: a sentence or two plus the question.
- Ask as many rounds as you need. When you have enough, set ready to true and say in a sentence what you'll build, without asking anything.
Confidence: start low on a vague description, and rise as the unknowns close. Never report 90 or more while an important question is open.${declined}`,
    transcript(turns),
    'medium',
  );
}

// --- 3. Build: the hidden files ---

const DEPARTMENTS = ['engineering', 'marketing', 'sales', 'finance', 'research', 'operations'] as const;

const BuildSchema = z.object({
  name: z.string().describe('Short agent name, 1-3 words, title case, e.g. "Invoice Chaser"'),
  department: z.enum(DEPARTMENTS),
  charter: z
    .string()
    .describe(
      'The full CHARTER.md in Markdown: # CHARTER - <name>, then ## Mission, ## What this agent does, ## What this agent does not do, ## Autonomy tier (which actions are T0, T1, T2 and why), ## Guardrails, ## When to ask a person (Requests for things only a person can give; Approvals for T2 actions; never rely on anyone reading its channel), ## Standard run (start from its task list), ## Definition of a good run. Specific to this agent, no filler.',
    ),
  model: z
    .enum(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'])
    .describe('The model the agent runs on: opus for open-ended judgement, sonnet for routine multi-step work, haiku for simple high-volume work'),
  tools: z
    .array(
      z.object({
        id: z.string().describe('A catalogue tool id (server.tool), or the id of one of your new_tools'),
        tier: z.enum(['T0', 'T1', 'T2']),
        why: z.string().describe('A few words: why it needs this tool, and why this tier if it differs from the default'),
      }),
    )
    .describe('Every tool the job needs - catalogue ones and new ones. Leave out anything it does not need. Do not list the fleet plumbing.'),
  approval_hours: z
    .array(z.object({ id: z.string(), hours: z.number().describe('How long a T2 approval waits before it expires') }))
    .describe('One entry per T2 tool'),
  new_tools: z
    .array(
      z.object({
        server: z.string().describe('Server name, lowercase; reuse a catalogue server name when it extends that system'),
        name: z.string().describe('snake_case verb_noun'),
        description: z.string(),
        input_schema: z.string().describe('JSON Schema for its input, as a JSON string'),
        how_it_works: z.string().describe('What it calls (API, endpoint, library) and what it returns'),
      }),
    )
    .describe('Tools the catalogue does not have that this agent needs. Empty when the catalogue covers it.'),
  kpi: z
    .array(z.object({ id: z.string().describe('A tool id from tools'), label: z.string().describe('Plural, lowercase, e.g. "invoices chased"') }))
    .describe('1-4 actions whose successful calls are the real output of this agent. Never reads or plumbing.'),
  max_runs_per_day: z.number().describe('Runaway backstop, not the cadence: comfortably above what the job needs'),
});

export type Build = z.infer<typeof BuildSchema>;

export async function build(turns: Turn[]): Promise<Build> {
  return parse(
    BuildSchema,
    `The interview is over. Write this agent's files from the conversation. Tier every tool deliberately: start from the catalogue default; anything visible outside the organisation or hard to undo is T2; when the person said something needs their OK, make it T2; when they said it can just do it, lower it only if it's reversible. Define new tools for anything the catalogue can't do.`,
    [...transcript(turns), { role: 'user', content: 'Build it.' }],
    'high',
  );
}
