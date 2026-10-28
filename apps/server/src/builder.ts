import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import * as z from 'zod/v4';
import { BASELINE, catalogForPrompt } from './catalog.js';
import { fleetForPrompt, type Fleet } from './fleet.js';
import { profileForPrompt, type Profile } from './org.js';

// The agent builder (docs/agent-creation.md): one conversation that turns a
// person's description into a Charter, TOOLS.yaml and KPI.yaml - written for
// their organisation, and reusing the tools their fleet already has.

const client = new Anthropic();
const MODEL = 'claude-opus-5-5';
// On a policy decline, rerun the request on Anthropic's recommended fallback
// model instead of returning the refusal.
const FALLBACK = { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const };

export type Pack = { id: string; name: string; tagline: string; agents: { name: string; does: string }[] };
export type Turn = { role: 'person' | 'builder'; text: string };
// Who the agents work for, and what the fleet already has.
export type Context = { profile: Profile | null; fleet: Fleet };

export class BuilderError extends Error {}

const ABOUT = `You are the agent builder in Extremely Autonomous Agents, an app where a person runs a fleet of autonomous AI agents for their organisation. Each agent runs on its own schedule, uses tools, and asks a person only when it must.

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

Writing for the organisation: a Charter is written for one specific organisation, the way a real employee's brief would be. Name the organisation, what it sells and to whom, the voice it speaks in, and the actual people the agent reports to, asks, or writes as (by name and role, from the profile). Refer to the fleet's other agents by name when it hands work to them. Never invent facts about the organisation: where the profile doesn't say, keep that part general.

Tools: prefer what exists. First the tools this fleet already uses (listed with the organisation below), then the catalogue. Reuse their exact ids. Never define a near-duplicate of a tool that already does the job under another name (no email_marketing.send when gmail.send_email exists). Only define a new tool when nothing existing does the job, or when a narrower version is needed so some uses can skip approval - and then say why in its "why".

The tool catalogue (server.tool [default tier] what it does):

${catalogForPrompt()}

Every agent also gets this fleet plumbing automatically - never define tools that duplicate it, and never ask about it:
${BASELINE.map(({ server, tool }) => `- ${server}.${tool.name} [${tool.tier}] ${tool.does}`).join('\n')}
Handing work to another agent is tasks.delegate_task.
When nothing does a job, you define a new tool yourself and it gets built; the person doesn't have to arrange anything.`;

function contextBlock(ctx: Context): string {
  const who = ctx.profile
    ? `The organisation these agents work for:\n${profileForPrompt(ctx.profile)}`
    : 'No organisation profile yet: keep organisation-specific details general.';
  return `${who}\n\n${fleetForPrompt(ctx.fleet)}`;
}

// The general rules, then this organisation and fleet (both change rarely, so
// both are cached), then the task at hand.
const system = (ctx: Context | null, task: string): Anthropic.Beta.BetaTextBlockParam[] => [
  { type: 'text', text: ABOUT, cache_control: { type: 'ephemeral' } },
  ...(ctx ? [{ type: 'text' as const, text: contextBlock(ctx), cache_control: { type: 'ephemeral' as const } }] : []),
  { type: 'text', text: task },
];

function transcript(turns: Turn[]): Anthropic.Beta.BetaMessageParam[] {
  return turns.map(t => ({ role: t.role === 'person' ? 'user' : 'assistant', content: t.text }));
}

async function parse<T extends z.ZodType>(
  schema: T,
  ctx: Context | null,
  task: string,
  messages: Anthropic.Beta.BetaMessageParam[],
  effort: 'low' | 'medium' | 'high',
): Promise<z.infer<T>> {
  try {
    const res = await client.beta.messages.parse({
      model: MODEL,
      // Just under where the SDK insists on streaming; a build writes a whole Charter.
      max_tokens: 21000,
      system: system(ctx, task),
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

// --- 0. The organisation profile (once, before the first agent) ---

const ProfileSchema = z.object({
  name: z.string(),
  what_it_does: z.string().describe('One or two sentences'),
  customers: z.string().describe('Who it sells to or serves'),
  offering: z.string().describe('Its products or services'),
  voice: z.string().describe('How it sounds when it writes to people'),
  people: z.array(z.object({ name: z.string(), role: z.string() })).describe('People agents may report to, ask, or write as'),
  notes: z.array(z.string()).describe('Other durable facts worth every agent knowing, one sentence each'),
});

const ProfileTurnSchema = z.object({
  reply: z.string().describe('Your next message to the person'),
  confidence: z.number().describe('0-100: how complete the profile is'),
  ready: z.boolean().describe('True when the profile is good enough and you are not asking anything in this reply'),
  profile: ProfileSchema.describe('Your best draft of the profile so far; use empty strings for unknowns'),
});

export async function profileInterview(orgName: string, turns: Turn[]) {
  return parse(
    ProfileTurnSchema,
    null,
    `Before any agent is built, you are setting up the organisation profile that every agent's Charter will be written from. The organisation is called "${orgName}" in the app. Find out, in plain words: what it does, who its customers are, what it sells, how it sounds when it writes, and the key people agents should report to or write as (names and roles). Two to four short rounds at most - one or two questions at a time, and fill in what you can infer. When you have enough, set ready to true and say in a sentence that you'll write every agent for them from now on.`,
    // The chat opens with a canned question from the builder; the API needs a
    // person's turn first.
    [{ role: 'user', content: 'Set up our organisation profile.' }, ...transcript(turns)],
    'low',
  );
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
    null,
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

export async function interview(ctx: Context, turns: Turn[], declinedPack: string | null) {
  const declined = declinedPack
    ? `\n\nEarlier you recommended the ready-made "${declinedPack}" pack and the person carried on instead, so what they want is different. If it isn't obvious how, you may ask once. Never recommend a pack again.`
    : '';
  return parse(
    TurnSchema,
    ctx,
    `You are now interviewing the person so you can write their agent. Each reply:
- Ask only what you genuinely can't work out or sensibly default yourself: which systems it works in (when it matters which, and the fleet doesn't already tell you), where its work goes, what it must never do, what needs their OK before it happens, what "done well" looks like. Use what you know about the organisation and fleet instead of asking. Make sensible assumptions about the rest and say what you assumed in a few words.
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
      'The full CHARTER.md in Markdown, written for this organisation: # CHARTER - <name>, then ## Mission, ## What this agent does, ## What this agent does not do, ## Autonomy tier (which actions are T0, T1, T2 and why), ## Guardrails, ## When to ask a person (Requests for things only a person can give; Approvals for T2 actions; never rely on anyone reading its channel), ## Standard run (start from its task list), ## Definition of a good run. Specific to this agent, no filler.',
    ),
  model: z
    .enum(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'])
    .describe('The model the agent runs on: opus for open-ended judgement, sonnet for routine multi-step work, haiku for simple high-volume work'),
  tools: z
    .array(
      z.object({
        id: z.string().describe("A fleet tool id, a catalogue tool id (server.tool), or the id of one of your new_tools"),
        tier: z.enum(['T0', 'T1', 'T2']),
        why: z.string().describe('A few words: why it needs this tool, and why this tier if it differs from the default'),
      }),
    )
    .describe('Every tool the job needs. Leave out anything it does not need. Do not list the fleet plumbing.'),
  approval_hours: z
    .array(z.object({ id: z.string(), hours: z.number().describe('How long a T2 approval waits before it expires') }))
    .describe('One entry per T2 tool'),
  new_tools: z
    .array(
      z.object({
        server: z.string().describe('Server name, lowercase; reuse an existing server name when it extends that system'),
        name: z.string().describe('snake_case verb_noun'),
        description: z.string(),
        input_schema: z.string().describe('JSON Schema for its input, as a JSON string'),
        how_it_works: z.string().describe('What it calls (API, endpoint, library) and what it returns'),
      }),
    )
    .describe('Tools that neither the fleet nor the catalogue has and this agent needs. Empty when existing tools cover it.'),
  kpi: z
    .array(z.object({ id: z.string().describe('A tool id from tools'), label: z.string().describe('Plural, lowercase, e.g. "invoices chased"') }))
    .describe('1-4 actions whose successful calls are the real output of this agent. Never reads or plumbing.'),
  max_runs_per_day: z.number().describe('Runaway backstop, not the cadence: comfortably above what the job needs'),
  profile_notes: z
    .array(z.string())
    .describe('New durable facts about the organisation learned here that every agent should know, one sentence each. Empty if none.'),
});

export type Build = z.infer<typeof BuildSchema>;

const TIERING = `Tier every tool deliberately: start from its default; anything visible outside the organisation or hard to undo is T2; when the person said something needs their OK, make it T2.

A tier belongs to a whole tool, not to a situation. So when SOME uses of a tool may go ahead without asking and others must wait (e.g. "the first reminder can just go, the rest need my OK"), split it: define a narrower new tool that can only do the unasked part, with the limits built into the tool itself (a fixed recipient, a fixed template, once per thing, a cap), tier that one lower, and keep the general tool at its stricter tier for everything else. Honour what the person said rather than overriding it; only refuse to lower a tier when no narrow tool could make it safe, and say why in the Charter.`;

export async function build(ctx: Context, turns: Turn[]): Promise<Build> {
  return parse(
    BuildSchema,
    ctx,
    `The interview is over. Write this agent's files from the conversation, for this organisation. ${TIERING}`,
    [...transcript(turns), { role: 'user', content: 'Build it.' }],
    'high',
  );
}

// --- 4. Customize a pack agent for this organisation ---

export async function customize(ctx: Context, template: Build, packName: string): Promise<Build> {
  const { profile_notes: _, ...files } = template;
  const out = await parse(
    BuildSchema,
    ctx,
    `This agent was just added from the ready-made "${packName}" pack. Its files below were written for a generic small business. Rewrite them for this organisation and this fleet:
- Charter: keep its structure, rigour and safety rules, but make it this organisation's: its name, what it sells and to whom, its voice, the real people it reports to or writes as, and its teammates in the fleet by name. Drop generic placeholders. Don't invent facts the profile doesn't give.
- Tools: wherever a fleet tool does the same job, use the fleet tool's exact id instead (and drop the template's duplicate new tool). Keep the template's narrow, limited tools only when nothing in the fleet already does that. Keep tiers at least as strict as the template unless a narrow tool makes a case safe.
- Keep its name and department. ${TIERING}

Template files (JSON):
${JSON.stringify(files, null, 2)}`,
    [{ role: 'user', content: 'Customize it for us.' }],
    'high',
  );
  return { ...out, name: template.name, department: template.department };
}
