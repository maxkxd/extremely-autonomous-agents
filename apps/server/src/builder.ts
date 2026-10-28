import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import * as z from 'zod/v4';
import { BASELINE, catalogForPrompt } from './catalog.js';
import { anthropicKey } from './models/connections.js';
import { fleetForPrompt, type Fleet } from './fleet.js';
import type { Available } from './models/connections.js';
import { personForPrompt, profileForPrompt, type PersonProfile, type Profile } from './org.js';

// The agent builder (docs/agent-creation.md): one conversation that turns a
// person's description into a Charter, TOOLS.yaml and KPI.yaml - written for
// their organisation, and reusing the tools their fleet already has.

// The Anthropic key: from Settings > Connectors if there is one, else the server's own.
const clientFor = async () => new Anthropic({ apiKey: await anthropicKey() });
const MODEL = 'claude-opus-5-5';
// On a policy decline, rerun the request on Anthropic's recommended fallback
// model instead of returning the refusal.
const FALLBACK = { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const };

export type Pack = { id: string; name: string; tagline: string; agents: { name: string; does: string }[] };
export type Turn = { role: 'person' | 'builder'; text: string };
// Who you're talking to, the organisation (if they have one), and what the
// fleet already has.
export type Context = { person: PersonProfile; profile: Profile | null; fleet: Fleet; models: Available[] };

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
  const me = `You are talking to the person who owns these agents. What you know about them:\n${personForPrompt(ctx.person)}`;
  const org = ctx.profile
    ? `The organisation these agents work for:\n${profileForPrompt(ctx.profile, ctx.person.name)}`
    : "They aren't set up as an organisation: the agents work for them personally. Keep organisation-specific details general rather than inventing them - they get filled in over time.";
  return `${me}\n\n${org}\n\n${fleetForPrompt(ctx.fleet)}\n\n${modelsForPrompt(ctx.models)}`;
}

// The models this person has connected, for choosing each agent's three.
const MODELS_SHOWN = 60;
function modelsForPrompt(available: Available[]): string {
  if (!available.length) return 'Models connected: none yet. Leave an agent\'s models empty; it will be flagged until the person connects one.';
  return `Models connected (connection id: model ids). "plan" connections are subscriptions the person already pays for; "key" ones bill per use:\n${available
    .map(a => {
      const shown = a.models.slice(0, MODELS_SHOWN);
      const more = a.models.length - shown.length;
      return `- ${a.connection} [${a.kind}] ${a.name}: ${shown.join(', ')}${more > 0 ? ` (+${more} more)` : ''}`;
    })
    .join('\n')}`;
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
    const client = await clientFor();
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

// What counts as worth remembering. Every agent reads these profiles on every
// build, so anything transient would keep being brought up long after it stopped
// mattering.
const DURABLE = `Only what will still be true and useful to an agent months from now: lasting roles, responsibilities, preferences, standards and how they like to work. Never plans, intentions, one-off tasks, current projects, setup steps, or anything that stops being true once it's done (not "plans to set up X", "is moving to Y next month", "is working on Z"). Leave out anything trivial or that no agent would act on. When in doubt, leave it out. One short sentence each; usually empty.`;

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
  person_notes: z
    .array(z.string())
    .describe(`New facts about the person you're talking to. ${DURABLE}`),
});

export async function profileInterview(orgName: string, person: PersonProfile, turns: Turn[]) {
  return parse(
    ProfileTurnSchema,
    null,
    `Before any agent is built, you are setting up the organisation profile that every agent's Charter will be written from. ${orgName ? `The organisation is called "${orgName}" in the app.` : "You don't know its name yet: get it first, and put it in the profile's name."}

You are talking to the person setting it up. What you already know about them - don't ask for it again, and include them in the profile's people:
${personForPrompt(person)}
 Find out, in plain words: what it does, who its customers are, what it sells, how it sounds when it writes, and the key people agents should report to or write as (names and roles). If you don't know the person's own role in it, ask that alongside the people question. Two to four short rounds at most - one or two questions at a time, and fill in what you can infer. When you have enough, set ready to true and say in a sentence that you'll write every agent for them from now on.`,
    // The chat opens with a canned question from the builder; the API needs a
    // person's turn first.
    [{ role: 'user', content: 'Set up our organisation profile.' }, ...transcript(turns)],
    'low',
  );
}

// --- 0b. Which key people are members of the organisation in the app ---

const MemberMatchSchema = z.object({
  links: z
    .array(
      z.object({
        index: z.number().describe('The key person, by their index'),
        member: z.string().nullable().describe("The member's username exactly as listed, or null"),
      }),
    )
    .describe('One entry per key person you were asked to decide'),
});

export type KeyPerson = { index: number; name: string; role: string; member?: string | null };

// decide: the indexes to decide; the rest are context (and may already hold a member).
export async function matchMembers(people: KeyPerson[], decide: number[], members: PersonProfile[]) {
  const list = people
    .map(p => `- [${p.index}] ${p.name}: ${p.role || '(no role given)'}` + (decide.includes(p.index) ? ' <- decide' : p.member ? ` (already linked to ${p.member})` : ''))
    .join('\n');
  const accounts = members.map(m => `- username: ${m.name}\n${personForPrompt(m).replace(/^/gm, '    ')}`).join('\n');
  return parse(
    MemberMatchSchema,
    null,
    `Your only job: say which of an organisation's key people (named in its profile) are the same human as one of its members (accounts in the app). A link means agents will treat that account as that person - asking them for approvals, writing as them - so a wrong link is much worse than a missing one.

Link a key person to a member only when you're confident they are the same person: the names refer to the same human (a username or first name can stand for a full name) and nothing in the member's own profile contradicts the key person's role. Return null when unsure, including when:
- more than one member could be them, or another key person could equally be that member (two people called Adrian - an owner and a salesperson - and one member Adrian whose profile doesn't say which: link neither);
- the member's profile gives a role that doesn't fit (a member who describes themselves as a junior developer isn't the key person listed as CEO);
- the only overlap is a common first name and nothing else lines up, while the key person has a surname the member's profile doesn't share.
Each member is at most one key person; never pick a member already linked to someone else.

Key people:
${list}

Members:
${accounts}`,
    [{ role: 'user', content: 'Decide the links.' }],
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
  models: z
    .array(
      z.object({
        connection: z.string().describe('A connection id from "Models connected"'),
        model: z.string().describe('One of that connection\'s model ids, exactly'),
        effort: z.enum(['low', 'medium', 'high', 'max']),
      }),
    )
    .describe(
      'Up to three models in order of preference, from "Models connected" only: the first is used, the others take over if it fails. Pick the best fit for the job - strong models for open-ended judgement, fast cheap ones for simple high-volume work - preferring plan connections over pay-per-use keys, and spreading the three across different connections where possible so one outage doesn\'t stop the agent. Effort: low for routine work, medium by default, high for hard judgement. Empty when nothing is connected.',
    ),
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
  ferocity: z
    .object({
      chill_every_hours: z
        .number()
        .describe('Chill: how often a run gets this job done, in hours - what a sensible person would schedule (bug triage twice a day = 12, outreach daily = 24, a policy check weekly = 168)'),
      steady_every_hours: z.number().describe('Steady: about 1.5x as often as Chill (Chill hours / 1.5), adjusted to what makes sense for the job'),
      driven_every_hours: z.number().describe('Driven: about 2x as often as Chill'),
      relentless_every_hours: z.number().describe('Relentless: about 4x as often as Chill'),
      driven_soft_floor: z.number().describe('Driven: output actions a good run makes; a run ending below it gets one gentle nudge. Modest.'),
      relentless_floor: z.number().describe('Relentless: the minimum output actions per run, excessively high for the job - these are extreme agents'),
      apocalyptic_floor: z.number().describe('Apocalyptic: deliberately out of reach, well above Relentless; runs go back to back and push toward it'),
      counts: z
        .array(z.string())
        .describe(
          'The tool ids whose calls count toward a floor - usually the kpi ids. If the main action has a natural limit (see natural_limits), count the actions of the extra work instead (e.g. files.write_file for stocked material), never the limited action.',
        ),
      hint: z.string().describe('Where else to look or what else to do when a run is below its floor: specific sources, approaches and streams of work for this job'),
      extra_effort: z
        .string()
        .describe(
          'What more output means for this job above Chill, where doing the main action more would be useless or harmful: e.g. a wallpaper agent stocks and rates ideas for future mornings and asks what the person likes, rather than changing the wallpaper again',
        ),
    })
    .describe('How hard it works at each ferocity level, set for this job. The person picks the level on the card.'),
  natural_limits: z
    .array(z.object({ tool: z.string(), max: z.number(), per_hours: z.number(), why: z.string() }))
    .describe('Actions the job itself caps at every ferocity, e.g. changing the desktop wallpaper at most 1 per 24 hours. Empty when the job has no natural limit.'),
  profile_notes: z
    .array(z.string())
    .describe(`New facts about the organisation that every agent should know. ${DURABLE}`),
  person_notes: z
    .array(z.string())
    .describe(`New facts about the person you're talking to. ${DURABLE}`),
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
  const { profile_notes: _p, person_notes: _n, ...files } = template;
  const out = await parse(
    BuildSchema,
    ctx,
    `This agent was just added from the ready-made "${packName}" pack. Its files below were written for a generic small business. Rewrite them for this organisation and this fleet:
- Charter: keep its structure, rigour and safety rules, but make it theirs: the organisation's name, what it sells and to whom, its voice, the real people it reports to or writes as (starting with the person you know), and its teammates in the fleet by name. Drop generic placeholders. Don't invent facts the profiles don't give - leave those parts general.
- Tools: wherever a fleet tool does the same job, use the fleet tool's exact id instead (and drop the template's duplicate new tool). Keep the template's narrow, limited tools only when nothing in the fleet already does that. Keep tiers at least as strict as the template unless a narrow tool makes a case safe.
- Keep its name and department. ${TIERING}

Template files (JSON):
${JSON.stringify(files, null, 2)}`,
    [{ role: 'user', content: 'Customize it for us.' }],
    'high',
  );
  return { ...out, name: template.name, department: template.department };
}
