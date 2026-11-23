import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import * as z from 'zod/v4';
import { BASELINE, CATALOG_INDEX, catalogForPrompt } from './catalog.js';
import { integrationEventsForPrompt, integrationToolIds, integrationToolsForPrompt } from './integrations/index.js';
import { registeredToolIds } from './runner/tools.js';
import { hostZone, PERIODS } from './runner/clock.js';
import { reportDefault, reportDefaultForPrompt, setReportDefault } from './runner/reports.js';
import { anthropicKey } from './models/connections.js';
import { jsonFromAnyModel, NoModelError } from './models/anyModel.js';
import { fleetForPrompt, type Fleet } from './fleet.js';
import type { Available } from './models/connections.js';
import { personForPrompt, profileForPrompt, type PersonProfile, type Profile } from './org.js';

// The agent builder (docs/agent-creation.md): one conversation that turns a
// person's description into a Charter, TOOLS.yaml and KPI.yaml - written for
// their organization, and reusing the tools their fleet already has.

// The Anthropic key: from Settings > Connectors if there is one, else the server's own.
const clientFor = (apiKey: string) => new Anthropic({ apiKey });
const MODEL = 'claude-opus-5-5';
// On a policy decline, rerun the request on Anthropic's recommended fallback
// model instead of returning the refusal.
const FALLBACK = { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const };

export type Pack = { id: string; name: string; tagline: string; agents: { name: string; does: string }[] };
export type Turn = { role: 'person' | 'builder'; text: string };
// Who you're talking to, the organization (if they have one), and what the
// fleet already has.
// elsewhere: the person is a teammate on their own computer - the agency runs on this one (its host's name).
export type Context = { person: PersonProfile; profile: Profile | null; fleet: Fleet; models: Available[]; elsewhere?: string | null };

export class BuilderError extends Error {}

const ABOUT = `You are the agent builder in Extremely Autonomous Agents, an app where a person runs a fleet of autonomous AI agents for their organization. Each agent runs on its own schedule, uses tools, and asks a person only when it must.

Every agent is defined by three files the person never sees:
- CHARTER.md: its mission, what it does and doesn't do, its guardrails, when it asks a person, and what a good run looks like.
- TOOLS.yaml: the tools it may call, each with a tier:
  T0 - just runs (reads, research, its own scratch documents).
  T1 - runs, and posts a notice to the agent's own channel (reversible internal writes: records, drafts, labels, notes).
  T2 - waits for a person's approval and expires if nobody decides (anything visible outside the organization or hard to undo: sending, posting, publishing, paying, deleting, inviting).
  A tool that isn't listed can't be called, so there is no "never" tier.
- KPI.yaml: which successful actions count as its output, and for each a goal: an amount for a period (an hour, a day, a week, a month or a year). The agency paces the agent to its goals by itself - more runs, more of them at once - so the goal is the output the person wants, never a cap.

People's pronouns: everything you write (Charter, tool notes, KPI labels, profile and person notes, your replies) refers to people by name, or as "they", unless their profile states their pronouns. Never guess pronouns from a name, and don't copy a pronoun from an existing note that only guessed one.

How agents work with people, which every agent must respect:
- Every agent has its own web browser (signed_in_browser.*) and the agency signs up for the accounts its job needs itself, keeping passwords in the agency's store; only a CAPTCHA or a phone code needs a person. New accounts the job can't start without go in accounts: they're made during the agent's setup, before it first runs, and the person does every check for them in one go. An agent asks a person for things through Requests (a key, spend, a decision) and Approvals (a T2 action). It never expects anyone to read its own channel.
- How hard an agent works follows from its goal (below), so don't ask about cadence beyond what the job itself needs (e.g. "within an hour of a ticket arriving" is a job requirement; "run more" isn't).
- API keys and passwords are added later in settings. Never ask for them and tell the person not to paste them into the chat.

Goals set the pace. Nobody picks how hard an agent works: the agency works out how often it runs, how many runs of it go at once and what each run is asked for from its goal - a steady rate of that amount over its period - and asks nothing more of it once it is there. An agent with no goal does not run at all, so every agent you build has one: at least one KPI row with an amount of 1 or more and its period. Guess a sensible basic number yourself - a good, ordinary pace for that job (20 leads a day, 5 posts a week, 1 report a week, 4 tickets an hour) - and say it in your reply; the person changes it on the agent's card. Ask them for the number only when it really matters to them (they spoke of a volume, a quota or a deadline). A build with no goal number is refused.
The pace plan you also write for each job (the ferocity fields) is what the agency paces within:
- steady_every_hours is the job's ordinary schedule - what a sensible person would schedule. The agent runs at it once its goal is reached, and never slower.
- relentless_floor is what one good run of this job makes: each run toward its goal is asked for that many (fewer only once its runs show they cannot), so set it to what a run can really do - too low makes many small runs, too high has every run pushed for more than it can make.
- counts, hint and extra_effort say what counts as output, where else to look when a run is short of what it was asked for, and what more effort means for this job.
- The other numbers (driven_every_hours, relentless_every_hours, the other floors) are kept for the plan's shape: fill them in sensibly, faster and higher in that order. A job hunting an open-ended supply of work (lead research, prospecting, content ideas) can turn up new work every 10-30 minutes; a job driven by events (bug triage on a Sentry alert, incidents, tickets) is woken by them, and its schedule is only an idle sweep; a job with a fixed rhythm (a weekly report) keeps it.
max_runs_per_day sits well above anything the job does on purpose (a 10-minute pace is 144 a day).

Writing for the organization: a Charter is written for one specific organization, the way a real employee's brief would be. Name the organization, what it sells and to whom, the voice it speaks in, and the actual people the agent reports to, asks, or writes as (by name and role, from the profile). Refer to the fleet's other agents by name when it hands work to them. Never invent facts about the organization: where the profile doesn't say, keep that part general.

Tools: prefer what exists. First the tools this fleet already uses (listed with the organization below), then the catalogue. Reuse their exact ids. Never define a near-duplicate of a tool that already does the job under another name (no email_marketing.send when gmail.send_email exists). Only define a new tool when nothing existing does the job, or when a narrower version is needed so some uses can skip approval - and then say why in its "why".

The tool catalogue (server.tool [default tier] what it does):

${catalogForPrompt()}

Every agent also gets this fleet plumbing automatically - never define tools that duplicate it, and never ask about it:
${BASELINE.map(({ server, tool }) => `- ${server}.${tool.name} [${tool.tier}] ${tool.does}`).join('\n')}
Handing work to another agent is tasks.delegate_task.
Where an agent's reports go - a daily list, a summary, figures, an alert - is the person's call, and it belongs in their space, not this app: the agent's run report is a record in its DM channel, which nobody is expected to read. So when the job produces something for them to read and they haven't said where: this person's default place for reports (said with what you know about them, above), when they have one - build it in, with its tool, and say in your reply that's where they'll go; otherwise ask where they'd like it (one question): emailed to them, a Notion page, a Google Drive folder, a dashboard they use (PostHog), a folder on this computer (their Documents or Desktop) - or kept here in the app. Build in what they pick: its tool (a folder on this computer is computer_files.write_file, with the folder's path in the Charter - those three computer_files tools are all there is: never define a narrower one, since each save waits for the person's OK until they lower it themselves on the Tools page, and your reply says so), and the Charter says to deliver each report there. They don't mind, don't know, or leave it to you: the Charter says to keep each report in its run's report for now and ask them once, with a request, where they'd rather have them - never just leave it in the app. Never define a tool to post, publish or pin a report inside this app. Chat or texting only when they ask for it there ("post in Slack"): each one is a connection they have to set up - Gmail alone is a Google Cloud project. The same for what it keeps for itself - a running to-do, a log, what it has already seen or matched: its own files (files.*) and memory, which need no connection. A sheet or document in the person's Drive only when they ask for one there: "in your own files" or "in your workspace" is files.*, not docs.*. Those files are the agent's private notes - no person ever opens them - so whatever the person reads (the running summary, the list) goes where their reports go, and a document they keep and use goes in a real place of theirs (Drive, Notion...), never the agent's files; the Charter says so.
A service the person didn't name is a connection they'd have to set up, so it goes in only when the job can't be done without it, or it's already connected here. Another agent using it isn't enough - Lead research can keep its own list of who it found rather than check a CRM nobody connected; say in your reply it could also check that service once it's connected. Don't offer one in a question either ("should I email you a digest?") - except where its reports go, asked as above: otherwise, asked what they'd like, or left to your judgement, the answer is the one that needs nothing new connected.
A job on a website - their Etsy or eBay shop's orders, a supplier or bank portal, LinkedIn, signing up for a service - when the service has no simple key or sign-in for apps: the agent's own browser (signed_in_browser.*, which every agent has), signed in to that site once by the person when it's their own account, or by the agent signing up itself. Not reading the site's notification emails instead: that needs their email connected, and Gmail is a Google Cloud project.
When nothing does a job, you define a new tool yourself and it gets built; the person doesn't have to arrange anything.

Events: an agent runs on its schedule, and can also be woken by events - something happening at a service it watches (a new error report, a support ticket, an alarm). When the job is reacting to something ("triage each new bug", "answer tickets as they come in", "act when an alarm fires"), give it the event: an existing one by id, or a new event you define, which gets set up like a new tool. The schedule stays as a slow sweep for anything missed.`;

function contextBlock(ctx: Context): string {
  const me = `You are talking to the person who owns these agents. What you know about them:\n${personForPrompt(ctx.person)}\nTheir time zone is ${hostZone()}: schedules and "a day" run on it, so never ask for it.\n${reportDefaultForPrompt(ctx.person.name)}${ctx.elsewhere ? `\nThey use this agency from their own computer; it runs on ${ctx.elsewhere}'s. So "this computer" - a folder, their Desktop or Documents (computer_files) - is ${ctx.elsewhere}'s computer, which they can't open: when they ask for a folder on their computer, say so and offer a place they can reach (emailed to them, Google Drive, Notion), or a folder on ${ctx.elsewhere}'s computer if they still want it there.` : ''}`;
  const org = ctx.profile
    ? `The organization these agents work for:\n${profileForPrompt(ctx.profile, ctx.person.name)}`
    : "They aren't set up as an organization: the agents work for them personally. Keep organization-specific details general rather than inventing them - they get filled in over time.";
  return `${me}\n\n${org}\n\n${fleetForPrompt(ctx.fleet, new Set([...registeredToolIds(), ...CATALOG_INDEX.keys()]))}\n\n${integrationsForPrompt()}\n\n${eventsForPrompt()}\n\n${modelsForPrompt(ctx.models)}`;
}

// Events (docs/events.md): things happening at connected services that can wake an agent.
function eventsForPrompt(): string {
  const events = integrationEventsForPrompt();
  return events
    ? `Events from connected services (give them by id in events; define new_events for ones nothing provides yet):\n${events}`
    : 'No events are set up yet. An agent that should react to something happening at a service (a new error, a ticket, an alarm) gets new_events: the Agency Engineer sets them up.';
}

// Tools from services the person has connected (docs/integrations.md): use
// them by id like catalogue tools. web.web_search works from the start
// (Tavily's free mode) and through whichever search service is connected.
function integrationsForPrompt(): string {
  const tools = integrationToolsForPrompt();
  return tools
    ? `Tools from services connected in Settings (use these exact ids; a standard tool like web.web_search is served by whichever service is connected):\n${tools}`
    : 'No extra services are connected yet. Catalogue tools that need one (like web.web_search) can still be given: they start working once the person connects a service.';
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

// The general rules, then this organization and fleet (both change rarely, so
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
  // No working Anthropic key (a packaged app has no .env one): whatever AI is connected.
  const key = await anthropicKey();
  if (!key) return viaAnyModel(schema, ctx, task, messages);
  try {
    const client = clientFor(key);
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
    // A long Charter (Infrastructure SRE's) can run out of room mid-JSON, which the SDK
    // reports as unparseable: once more with less thinking, so more is left for the files.
    if (e instanceof Error && /Failed to parse structured output/.test(e.message)) {
      if (effort !== 'low') return parse(schema, ctx, task, messages, effort === 'high' ? 'medium' : 'low');
      throw new BuilderError('The reply was cut off. Try again.');
    }
    // The key refused or out of credit: another connected AI may still do it.
    const refused =
      e instanceof Anthropic.AuthenticationError ||
      e instanceof Anthropic.PermissionDeniedError ||
      (e instanceof Anthropic.APIError && /credit balance|billing|quota/i.test(String((e.error as { error?: { message?: string } } | undefined)?.error?.message ?? e.message)));
    if (refused) {
      try {
        return await viaAnyModel(schema, ctx, task, messages, c => c === 'anthropic');
      } catch (other) {
        if (!(other instanceof BuilderError && /No AI model/.test(other.message))) throw other;
        throw new BuilderError('The Anthropic key was refused (or is out of credit). Check it in Settings > Connectors, or connect another AI model.');
      }
    }
    if (e instanceof Anthropic.RateLimitError) throw new BuilderError('Rate limited by the Claude API. Wait a moment and try again.');
    if (e instanceof Anthropic.APIConnectionError) throw new BuilderError('Could not reach the Claude API.');
    // With Claude's own reason, so a rejected request says why (logged, and shown).
    if (e instanceof Anthropic.APIError) throw new BuilderError(`Claude API error (${e.status}): ${String((e.error as { error?: { message?: string } } | undefined)?.error?.message ?? e.message).slice(0, 300)}`);
    // No credentials at all: the SDK throws before any request.
    if (e instanceof Error && /api ?key|auth/i.test(e.message)) throw new BuilderError('No AI model is connected. Connect one in Settings > Connectors.');
    throw e;
  }
}

// The same answer from any connected AI (models/anyModel.ts): the instructions
// as one text, the conversation as it is.
async function viaAnyModel<T extends z.ZodType>(
  schema: T,
  ctx: Context | null,
  task: string,
  messages: Anthropic.Beta.BetaMessageParam[],
  skip?: (connection: string) => boolean,
): Promise<z.infer<T>> {
  const text = system(ctx, task)
    .map(b => b.text)
    .join('\n\n');
  const said = messages.map(m => ({
    role: m.role === 'assistant' ? ('assistant' as const) : ('user' as const),
    text: typeof m.content === 'string' ? m.content : (m.content ?? []).map(b => ('text' in b ? b.text : '')).join('\n'),
  }));
  try {
    return await jsonFromAnyModel(schema, text, said, skip);
  } catch (e) {
    if (e instanceof NoModelError) throw new BuilderError('No AI model is connected and working. Connect one in Settings > Connectors.');
    throw new BuilderError((e as Error).message);
  }
}

// What counts as worth remembering. Every agent reads these profiles on every
// build, so anything transient would keep being brought up long after it stopped
// mattering.
const DURABLE = `Only what will still be true and useful to an agent months from now: lasting roles, responsibilities, preferences, standards and how they like to work. Never plans, intentions, one-off tasks, current projects, setup steps, or anything that stops being true once it's done (not "plans to set up X", "is moving to Y next month", "is working on Z"). Leave out anything trivial or that no agent would act on. When in doubt, leave it out. One short sentence each; usually empty.`;

// --- 0. The organization profile (once, before the first agent) ---

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

// existing: what's already written for it (typed in Settings before the chat): kept, and not asked again.
export async function profileInterview(orgName: string, person: PersonProfile, turns: Turn[], existing: Profile | null = null) {
  const written = existing && [existing.what_it_does, existing.customers, existing.offering, existing.voice].some(v => v?.trim()) ? existing : null;
  return parse(
    ProfileTurnSchema,
    null,
    `Before any agent is built, you are setting up the organization profile that every agent's Charter will be written from. ${orgName ? `The organization is called "${orgName}" in the app.` : "You don't know its name yet: get it first, and put it in the profile's name."}

You are talking to the person setting it up. What you already know about them - don't ask for it again, and include them in the profile's people:
${personForPrompt(person)}
${written ? `\nAlready written for this organization - start from it: keep it in the profile word for word unless the person changes it, and don't ask for it again. Ask only about what's missing or empty:\n${profileForPrompt(written)}\n` : ''}
 Find out, in plain words: what it does, who its customers are, what it sells, how it sounds when it writes, and the key people agents should report to or write as (names and roles). If you don't know the person's own role in it, ask that alongside the people question. Two to four short rounds at most - one or two questions at a time, and fill in what you can infer. More than one question: a numbered list, each on its own line ("1. ...", "2. ..."), after a short sentence. When you have enough, set ready to true and say in a sentence that you'll write every agent for them from now on.`,
    // The chat opens with a canned question from the builder; the API needs a
    // person's turn first.
    [{ role: 'user', content: 'Set up our organization profile.' }, ...transcript(turns)],
    'low',
  );
}

// --- 0b. Which key people are members of the organization in the app ---

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
    `Your only job: say which of an organization's key people (named in its profile) are the same human as one of its members (accounts in the app). A link means agents will treat that account as that person - asking them for approvals, writing as them - so a wrong link is much worse than a missing one.

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

const INTERVIEW = `- Ask only what you genuinely can't work out or sensibly default yourself: which systems it works in (when it matters which, and the fleet doesn't already tell you), where its work goes, what it must never do, what needs their OK before it happens, what "done well" looks like. Use what you know about the organization and fleet instead of asking. Make sensible assumptions about the rest and say what you assumed in a few words.
- One or two short questions at a time, in plain words, no jargon (never say T0/T1/T2, Charter or YAML).
- Keep it short: a sentence or two plus the question.
- More than one question: a numbered list, each on its own line ("1. ...", "2. ..."), after your sentence. Bullet points ("- ...") for anything else that's a list.`;

export async function interview(ctx: Context, turns: Turn[], declinedPack: string | null) {
  const declined = declinedPack
    ? `\n\nEarlier you recommended the ready-made "${declinedPack}" pack and the person carried on instead, so what they want is different. If it isn't obvious how, you may ask once. Never recommend a pack again.`
    : '';
  return parse(
    TurnSchema,
    ctx,
    `You are now interviewing the person so you can write their agent. Each reply:
${INTERVIEW}
- Ask as many rounds as you need. When you have enough, set ready to true and say in a sentence what you'll build, without asking anything.
Confidence: start low on a vague description, and rise as the unknowns close. Never report 90 or more while an important question is open.${declined}`,
    transcript(turns),
    'medium',
  );
}

// The builder's whole brief as text, for an AI IDE building an agent through the
// agency's MCP server (runner/agency-mcp.ts): the same instructions, catalogue,
// organization, fleet, connected services, events and models the builder sees,
// how it interviews, and how it tiers. The build itself is create_agent's input,
// whose fields carry the rest of the builder's guidance.
export function builderGuide(ctx: Context): string {
  return [
    ABOUT,
    contextBlock(ctx),
    `Before you build, talk to the person (in your own chat with them) the way the builder interviews:\n${INTERVIEW}\n- Ask as many rounds as you need; when you have enough, say in a sentence what you'll build.`,
    `Building it (create_agent): write every field for this organization. ${TIERING}\n\nIds must exist: tools from the fleet, the catalogue above, connected services, or your own new_tools (server.tool); events from those listed above, or your own new_events; models from the connected ones above. A KPI and a ferocity count must name one of the agent's tools. At least one KPI row needs a goal: an amount of 1 or more, with its period.`,
  ].join('\n\n---\n\n');
}

// --- 3. Build: the hidden files ---

const DEPARTMENTS = ['engineering', 'marketing', 'sales', 'finance', 'research', 'operations'] as const;

const ACCOUNTS = z.array(z.object({ site: z.string().describe('The site, e.g. x.com'), purpose: z.string().describe('What it is for, in a few words: "the brand\'s X profile"'), how_many: z.number().describe('Usually 1') }));

// A client still on the tool list from before 18 Nov 2026 sends chill_every_hours (the job's
// sensible pace, now Steady's) and steady_every_hours (the old, faster Steady, now gone): the
// first is the pace.
// A KPI row from before goals had periods (a pack's template, an older client): its
// per_day is the amount, a day. No number at all is 0, which is no goal for that row.
const legacyGoal = (k: unknown) => {
  if (!k || typeof k !== 'object') return k;
  const { per_day, ...rest } = k as Record<string, unknown>;
  return { ...rest, amount: rest.amount ?? per_day ?? 0 };
};
// Every agent needs a goal (runner/goals.ts): a KPI row with a number.
export const hasGoalNumber = (b: { kpi: { amount?: number }[] }) => b.kpi.some(k => Number.isFinite(k.amount) && Number(k.amount) >= 1);
export const NEEDS_GOAL =
  'It has no goal: give at least one KPI row an amount of 1 or more and its period (hour, day, week, month or year) - a sensible basic number for an ordinary pace of this job. An agent with no goal does not run.';

const legacyPace = (f: unknown) => {
  if (!f || typeof f !== 'object' || !('chill_every_hours' in f)) return f;
  const { chill_every_hours, ...rest } = f as Record<string, unknown>;
  return { ...rest, steady_every_hours: chill_every_hours };
};

export const BuildSchema = z.object({
  name: z.string().describe('Short agent name, 1-3 words, title case, e.g. "Invoice Chaser"'),
  department: z.enum(DEPARTMENTS),
  charter: z
    .string()
    .describe(
      'The full CHARTER.md in Markdown, written for this organization: # CHARTER - <name>, then ## Mission, ## What this agent does, ## What this agent does not do, ## Autonomy tier (which actions are T0, T1, T2 and why), ## Guardrails, ## When to ask a person (Requests for things only a person can give; Approvals for T2 actions; never rely on anyone reading its channel), ## Standard run (start from its task list), ## Definition of a good run. Specific to this agent, no filler.',
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
  events: z
    .array(z.object({ id: z.string().describe('An event id from the connected services listed, or the id (server.name) of one of your new_events'), why: z.string() }))
    .describe(
      'What wakes this agent besides its schedule: things happening at a service that it reacts to - a new error report, a support ticket, an alarm, a payment failing. Empty for an agent that only works on its schedule. An agent with events still has a schedule: then Chill is a slow sweep for anything missed.',
    ),
  new_events: z
    .array(
      z.object({
        server: z.string().describe('The service, lowercase (sentry, zendesk, aws)'),
        name: z.string().describe('snake_case, what happened: new_issue, ticket_created, alarm_fired'),
        description: z.string().describe('What happened, in a few words'),
        how_detected: z.string().describe("How the service tells it: its webhook for this, or the API to poll for new items"),
      }),
    )
    .describe('Events nothing connected provides yet that this agent should wake on. The Agency Engineer sets each up and the person connects it. Empty when none.'),
  // Left out by an AI app building through the agency's MCP server: none.
  accounts: ACCOUNTS.default([]).describe(
      "New website accounts the agency signs up for before this agent first runs: ones the job can't start without, on sites nothing here connects to (an X profile for the brand, a Reddit account, a Product Hunt maker account). They're made during its setup - the Agency Engineer signs up, the person only does a CAPTCHA or a phone code, all of them in one go - and each shows on the agent's card. Not the person's own existing accounts (they sign in to those themselves), and nothing a connected service covers. For an agent whose job is to keep making accounts as it goes (one per brand it launches): only the ones it starts with - the Charter says it makes the rest itself, writing down every one it needs first. Empty when it needs none.",
  ),
  kpi: z
    .array(
      z.preprocess(
        legacyGoal,
        z.object({
          id: z.string().describe('A tool id from tools'),
          label: z.string().describe('Plural, lowercase, e.g. "invoices chased"'),
          amount: z
            .number()
            .describe(
              "Its goal for this output: how many per period is good work for this job at an ordinary pace (20 leads a day, 5 posts a week). A whole number; at least one row must have 1 or more - guess a sensible basic number rather than asking, unless the number really matters to the person. 0 only on a row where a number makes no sense. The person changes it on the agent's card.",
            ),
          period: z.enum(PERIODS).optional().describe('What the amount is per: hour, day, week, month or year. Left out: day.'),
        }),
      ),
    )
    .describe('1-4 actions whose successful calls are the real output of this agent. Never reads or plumbing. Each label is a goal the person can put a number on, so name it as they would say it. At least one needs a number: an agent with no goal does not run.'),
  max_runs_per_day: z.number().describe('Runaway backstop, not the cadence: comfortably above what the job needs'),
  ferocity: z.preprocess(
    legacyPace,
    z
    .object({
      steady_every_hours: z
        .number()
        .describe('Steady ("the default: gets the job done"): how often a run gets this job done, in hours - what a sensible person would schedule (bug triage twice a day = 12, outreach daily = 24, a policy check weekly = 168). Its ordinary schedule: it runs at this once its goal is reached, and never slower.'),
      driven_every_hours: z.number().describe('Driven ("never leaves output on the table"): as often as there is usually new work to find'),
      relentless_every_hours: z
        .number()
        .describe(
          'Relentless ("inhuman, never rests" - very high effort, not constant runs), in hours: as often as this job can turn up new real outcomes, which depends on the job, not on Steady. A stream of fresh work to find (lead research, outreach, content ideas): minutes - 0.17 (10 min) to 0.5. Work that arrives as events (bug triage on a Sentry alert, incidents, tickets): its events wake it, so this schedule is only an idle sweep, e.g. 6-8 hours - its intensity is each run digging to the bottom and booking follow-up runs, a high floor, and asking for more tools. Never more often than new work can appear (a weekly report stays weekly).',
        ),
      driven_soft_floor: z.number().describe('Driven: output actions a good run makes; a run ending below it gets one gentle nudge. Modest.'),
      relentless_floor: z
        .number()
        .describe('Relentless: the minimum real outcomes per run - set high, what a tireless expert gets done in one run of this job (bug triage woken by an alert: the issue filed, its notes, a repro, and anything related it turned up - not 1 or 2), but always reachable with real work and never above its natural limits (a cap of 15 a day over ~4 runs is ~4 a run; at a 10-minute pace, a run is a few outcomes)'),
      apocalyptic_floor: z.number().describe('Apocalyptic: well above Relentless, still real outcomes and still within natural limits; runs go back to back and push toward it'),
      counts: z
        .array(z.string())
        .describe(
          'The tool ids whose calls count toward a floor: real outcomes only - usually the kpi ids. Real means it leaves the agent and matters to someone: a record created or changed in a business system, a draft, an email, a post, a pull request, a document delivered to a shared place. Never workspace files (files.*), memory, tasks, requests or reports to the person (gmail.send_to_me) - counted, they were padded (one agent wrote 106 files to reach its number). If the main action has a natural limit (see natural_limits), still count it, and set the floors within the limit.',
        ),
      hint: z.string().describe('Where else to look or what else to do when a run is below its floor: specific sources, approaches and streams of work for this job'),
      extra_effort: z
        .string()
        .describe(
          'What more effort means for this job above Steady, where doing the main action more would be useless or harmful: wider and better real work (more sources searched, harder cases taken on), never files written to reach a number - e.g. a wallpaper agent finds better candidates and asks what the person likes, rather than changing the wallpaper again',
        ),
    })
    .describe('The pace plan for this job. Nobody picks a level: its goals set the pace (kpi), within this plan.'),
  ),
  natural_limits: z
    .array(z.object({ tool: z.string(), max: z.number(), per_hours: z.number(), why: z.string() }))
    .describe('Caps on an action whatever its pace - ONLY ones the person asked for in this conversation, in their own words ("at most one post a day"). Never add one because it seems sensible: the agency is here for as much good output as possible. The only other reason is a law, or a rule of the platform that would get the account banned (say which in why). Empty otherwise - and never write a cap into the Charter either.'),
  profile_notes: z
    .array(z.string())
    .describe(`New facts about the organization that every agent should know. ${DURABLE}`),
  person_notes: z
    .array(z.string())
    .describe(`New facts about the person you're talking to. ${DURABLE}`),
  report_place: z
    .string()
    .optional()
    .describe(
      "Where this agent's reports go when the person named a place in this conversation: exactly where (a folder's full path, \"email to the owner\", the Drive folder or Notion page), then \" | \" and the tool that delivers there - e.g. \"C:\\\\Users\\\\sam\\\\Documents\\\\Reports | computer_files.write_file\". Empty when they named none, or chose to keep them in the app.",
    ),
});

export type Build = z.infer<typeof BuildSchema>;

const TIERING = `Tier every tool deliberately: start from its default; anything visible outside the organization or hard to undo is T2; when the person said something needs their OK, make it T2.

A tier belongs to a whole tool, not to a situation. So when SOME uses of a tool may go ahead without asking and others must wait (e.g. "the first reminder can just go, the rest need my OK"), split it: define a narrower new tool that can only do the unasked part, with the limits built into the tool itself (a fixed recipient, a fixed template, once per thing, a cap), tier that one lower, and keep the general tool at its stricter tier for everything else. Honour what the person said rather than overriding it; only refuse to lower a tier when no narrow tool could make it safe, and say why in the Charter.`;

// What Claude writes for a build: BuildSchema with three rarely-used lists
// (approval hours, natural limits, new events) as JSON text, the way a new
// tool's input_schema already is. The whole BuildSchema as a structured-output
// grammar is just over Claude's size limit ("The compiled grammar is too large"),
// and each list of entries is what counts; this leaves room for two more. Turned
// back into a Build, each list checked against its own schema.
const TEXT_LISTS = ['approval_hours', 'natural_limits', 'new_events', 'accounts'] as const;
const listOf = (k: (typeof TEXT_LISTS)[number]) => (k === 'accounts' ? ACCOUNTS : BuildSchema.shape[k]);
const asJsonText = (k: (typeof TEXT_LISTS)[number]) =>
  z.string().describe(`${BuildSchema.shape[k].description ?? ''} As JSON text: an array of {${Object.keys((listOf(k).element as z.ZodObject).shape).join(', ')}}, or [] for none.`);
const BuildOutputSchema = BuildSchema.extend({
  report_place: BuildSchema.shape.report_place.unwrap(), // always said, empty for none
  approval_hours: asJsonText('approval_hours'),
  natural_limits: asJsonText('natural_limits'),
  new_events: asJsonText('new_events'),
  accounts: asJsonText('accounts'),
});
const fromText = <T extends z.ZodType>(schema: T, text: string): z.infer<T> | [] => {
  try {
    const r = schema.safeParse(JSON.parse(text));
    return r.success ? r.data : [];
  } catch {
    return [];
  }
};
// Files on the computer always start at approval: only the person lowers them
// (the Tools page), say for a machine set aside for the agents - never the builder.
// They're the three built-ins: a "narrower" one the builder made up to skip the
// approval (computer_files.write_tender_summary) can't be built - a plugin can't
// write files - so it's the built-in write instead.
const ALWAYS_APPROVED = /^computer_files\./;
const COMPUTER_TOOLS = new Set(['computer_files.read_file', 'computer_files.write_file', 'computer_files.list_folder']);
const computerTool = (id: string) => (ALWAYS_APPROVED.test(id) && !COMPUTER_TOOLS.has(id) ? 'computer_files.write_file' : id);
const fromOutput = (o: z.infer<typeof BuildOutputSchema>): Build => ({
  ...o,
  tools: o.tools
    .map(t => (ALWAYS_APPROVED.test(t.id) ? { ...t, id: computerTool(t.id), tier: 'T2' as const } : t))
    .filter((t, i, all) => all.findIndex(x => x.id === t.id) === i),
  new_tools: o.new_tools.filter(t => t.server !== 'computer_files'),
  kpi: o.kpi.map(k => ({ ...k, id: computerTool(k.id) })),
  ferocity: { ...o.ferocity, counts: o.ferocity.counts.map(computerTool) },
  approval_hours: fromText(BuildSchema.shape.approval_hours, o.approval_hours),
  natural_limits: fromText(BuildSchema.shape.natural_limits, o.natural_limits),
  new_events: fromText(BuildSchema.shape.new_events, o.new_events),
  accounts: fromText(ACCOUNTS, o.accounts),
});
export const buildOutputForTests = { schema: BuildOutputSchema, fromOutput };

// Email, chat and Drive documents are connections the person has to set up
// (Gmail is a Google Cloud project). On a cheap model the build kept adding them
// unasked - a weekly list "emailed" to someone who asked for a list - whatever
// the instructions said, so a build holding one nobody asked for is redone once.
const UNASKED: [RegExp, RegExp][] = [
  [/^gmail\./, /e-?mail|gmail|inbox|\bmail/i],
  [/^docs\./, /drive|google doc|\bdocs?\b|document|sheet/i],
  [/^slack\./, /slack/i],
  [/^computer_files\./, /folder|desktop|documents|downloads|this computer|my computer|on (my|the) (pc|laptop|mac|server)|[a-z]:[\\/]|~\//i],
];
export function unaskedTools(b: Pick<Build, 'tools'>, turns: Turn[], live: Set<string>): string[] {
  const said = turns.filter(t => t.role === 'person').map(t => t.text).join('\n');
  return b.tools.filter(t => !live.has(t.id) && UNASKED.some(([tool, words]) => tool.test(t.id) && !words.test(said))).map(t => t.id);
}

// The first place a person names for any of their agents' reports becomes their
// default (runner/reports.ts) - the builder told them so, and nothing else made it true.
// Read loosely: the model doesn't always write "place | tool" (the first live build
// left Sam with none) - the tool is whichever server.tool it names, else the agent's
// own way of delivering, and the place is what's left.
const DELIVERS = /^(computer_files\.write_file|gmail\.send_to_me|docs\.|notion\.)/;
export function firstReportPlace(b: Pick<Build, 'report_place'> & Partial<Pick<Build, 'tools'>>, person?: string | null) {
  if (reportDefault(person)) return;
  const said = (b.report_place ?? '').trim();
  if (!said) return;
  const named = [...said.matchAll(/\b([a-z][a-z0-9_]*\.[a-z][a-z0-9_]*)\b/g)].map(m => m[1]).find(t => DELIVERS.test(t));
  const tool = named ?? b.tools?.map(t => t.id).find(t => DELIVERS.test(t));
  const where = (named ? said.replace(named, '') : said).replace(/[|()\s,-]+$/g, '').replace(/^[|()\s,-]+/g, '').trim();
  if (!where || !tool) return void console.warn(`Builder: couldn't read where reports go from "${said.slice(0, 200)}"`);
  try {
    setReportDefault(where, tool, 'The first place they named for reports, while building an agent', person);
  } catch {
    // "kept in the app": not a default.
  }
}

export async function build(ctx: Context, turns: Turn[]): Promise<Build> {
  const task = `The interview is over. Write this agent's files from the conversation, for this organization. ${TIERING}`;
  const once = async (ask: string) => fromOutput(await parse(BuildOutputSchema, ctx, task, [...transcript(turns), { role: 'user', content: ask }], 'high'));
  const b = await once('Build it.');
  firstReportPlace(b, ctx.person.name);
  // The agency's default place for reports was asked for once already: its tool isn't unasked.
  const reportTool = reportDefault(ctx.person.name)?.tool;
  const extra = unaskedTools(b, turns, new Set([...ctx.fleet.tools.map(t => t.id), ...integrationToolIds(), ...(reportTool ? [reportTool] : [])]));
  const ask = extra.length
    ? `Build it, without ${extra.join(', ')}: the person didn't ask for that and it isn't connected. Its reports stay in its run's report for now, and the Charter says to ask them once, with a request, where they'd like them; what it keeps goes in its own files (files.*). Leave it out of the instructions too.`
    : 'Build it.';
  const built = extra.length ? await once(ask) : b;
  // Every agent needs a goal: a build without a number is redone once. One that still has
  // none waits, not running, for the Agency Engineer to set it (runner/scheduler.ts).
  return hasGoalNumber(built) ? built : once(`${ask} ${NEEDS_GOAL}`);
}

// --- 4. Customize a pack agent for this organization ---

// If a customizer drops the pack's goal numbers, put them back by tool id or label.
function withTemplateGoals(out: Build, template: Build): Build {
  if (hasGoalNumber(out)) return out;
  const byId = new Map(template.kpi.map(k => [k.id, k]));
  const byLabel = new Map(template.kpi.map(k => [k.label, k]));
  const kpi = out.kpi.map(k => {
    if (Number.isFinite(k.amount) && Number(k.amount) >= 1) return k;
    const t = byId.get(k.id) ?? byLabel.get(k.label);
    if (t && Number.isFinite(t.amount) && Number(t.amount) >= 1) return { ...k, amount: t.amount, period: k.period ?? t.period ?? 'day' };
    return k;
  });
  return { ...out, kpi };
}

export async function customize(ctx: Context, template: Build, packName: string): Promise<Build> {
  const { profile_notes: _p, person_notes: _n, ...files } = template;
  const prompt = (extra = '') =>
    `This agent was just added from the ready-made "${packName}" pack. Its files below were written for a generic small business. Rewrite them for this organization and this fleet:
- Charter: keep its structure, rigour and safety rules, but make it theirs: the organization's name, what it sells and to whom, its voice, the real people it reports to or writes as (starting with the person you know), and its teammates in the fleet by name. Drop generic placeholders. Don't invent facts the profiles don't give - leave those parts general.
- Tools: wherever a fleet tool does the same job, use the fleet tool's exact id instead (and drop the template's duplicate new tool). Keep the template's narrow, limited tools only when nothing in the fleet already does that. Keep tiers at least as strict as the template unless a narrow tool makes a case safe.
- Goals: every agent needs one. Give at least one KPI row an amount of 1 or more and its period - a sensible basic number for an ordinary pace of this job at an organization this size. Keep the template's numbers unless a different pace clearly fits this organization.
- Keep its name and department. ${TIERING}${extra}

Template files (JSON):
${JSON.stringify(files, null, 2)}`;
  const once = async (ask: string) => fromOutput(await parse(BuildOutputSchema, ctx, ask, [{ role: 'user', content: 'Customize it for us.' }], 'high'));
  // Every pack agent needs a goal: a customize without a number is redone once, then the
  // template's own numbers are kept if the model still left them out.
  const first = { ...(await once(prompt())), name: template.name, department: template.department };
  const built = hasGoalNumber(first) ? first : { ...(await once(prompt(` ${NEEDS_GOAL}`))), name: template.name, department: template.department };
  return withTemplateGoals(built, template);
}
