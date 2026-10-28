# Agent creation

How a new agent gets made. It's modelled on the WAR agency runner: every agent
is a **Charter** (what it's for and how it behaves) plus a **TOOLS.yaml** (what
it can touch, and which actions need a person's OK) plus a **KPI.yaml** (which
actions count as its output). The person creating the agent never sees any of
these files. They describe what they want, in a conversation, and the agent
builder writes the files.

## Your organisation comes first

Every agent is written for one organisation, the way a real employee's brief
would be: it names the company, what it sells and to whom, the voice it writes
in, and the actual people it reports to or writes as. That comes from the
**organisation profile** (`apps/server/data/orgs/<org>.json`).

The first time you add anything (a description or a pack), a short chat in the
same pop-up fills the profile in: what you do, who for, your voice and the key
people. Then it carries on with what you were doing. The builder adds durable
facts it learns in later conversations to the profile's notes.

## The flow

1. **Write into the box.** The "Customize your own agent" card on the New agent
   page is the input. There's no separate screen to start.
2. **Look for a pack first.** The builder compares the description with the
   packs on the page (only the packs, never your own agents). If one is a real
   fit, the page scrolls down to it, highlights it, and marks it "Recommended".
   This happens **at most once** per creation.
3. **Say it's different.** If you scroll back up and keep writing in the box,
   the builder accepts that it's different (it may say what it took the
   difference to be) and doesn't recommend anything again.
4. **The box opens into a big pop-up.** The conversation continues there. A
   blue bar across the top shows the builder's **confidence** that it
   understands the agent well enough to build it (0-100%, re-estimated every
   turn). It asks as many questions as it needs, but only ones it genuinely
   can't answer itself.
5. **Build.** Once it's confident, it drafts the Charter, TOOLS.yaml and
   KPI.yaml (all hidden). Any tool the agent needs that doesn't exist yet, the
   builder **defines and builds itself**, with no approval. It came out of a
   conversation with a person, so a separate approval would only repeat it.
6. **Review.** The screen fades to black, leaving only the new agent's
   dashboard card floating in the centre. There's an X to cancel and a
   **hold-to-accept** button under the card.
7. **Accept.** Everything fades back to the dashboard and the card smashes into
   it, pushing the other cards out of the way. A new agent **always starts on
   Chill**.

## Adding a pack

Clicking a pack's Add button goes straight to the black reveal with all its
agents (up to three, sized to fit), X to cancel, hold to add. They all smash
into the dashboard at once, on Chill.

Pack agents ship **pre-built** (`apps/server/packs/`, by
`scripts/build-packs.ts`): each was written with the closest real WAR agency
agent's Charter and TOOLS.yaml as a reference, then reviewed. They're generic on
purpose. **Adding a pack then tailors each one to you in the background:**

1. On accept, each agent's generic files are saved at once, so it exists and is
   valid straight away, marked **setting up**.
2. The server rewrites it for your organisation profile and fleet (about half a
   minute to a couple of minutes per agent, three at a time): your company,
   customers, voice and people go into the Charter; wherever a tool your fleet
   already has does the same job, it switches to that exact tool and drops its
   own duplicate. Tiers stay at least as strict as the template.
3. The server owns this work: it carries on if the app is closed and resumes
   after a restart. If it fails three times, the agent keeps its generic files
   (still valid, just not tailored).

While an agent is setting up, its card says so, it can't be run or tuned, and a
DM sent to it waits and is answered once it's ready.

## Tiers

Three tiers, the same as the runner minus T3:

| Tier | What happens | Used for |
|---|---|---|
| T0 | Just runs | Reads, searches, browsing, its own scratch files: anything that would be pure noise to log |
| T1 | Runs, and a notice lands in the agent's DM channel | Reversible internal writes: records, drafts, labels, tasks, notes to other agents |
| T2 | Waits in **Approvals** until a person decides; expires if nobody does | Anything visible outside the organisation or hard to undo: sending, posting, publishing, paying, deleting |

There's no "never" tier. If a tool isn't in TOOLS.yaml, the agent can't call
it. Leaving a tool out is how you forbid it.

**A tier belongs to a whole tool, not a situation, so the builder splits tools.**
When you say some uses of a tool can go ahead without asking and others need
your OK ("the first reminder can just go, the rest wait for me"), the builder
makes a narrower tool that can only do the unasked part, and tiers it lower.
The limits are enforced by the tool itself (fixed recipient, fixed template,
once per invoice), not left to the agent's judgement. The general tool keeps
its stricter tier for everything else. Example: `gmail.send_first_reminder`
(T1, fixed template, once per invoice, 1-6 days overdue) alongside
`gmail.send_email` (T2).

Every T2 tool gets an approval window (how long it waits) and what happens when
it runs out: always `expire`. An action nobody reviewed in time doesn't run
unattended.

## Where tools come from

The builder always prefers what exists, in this order:

- **Your fleet's tools**: every tool any of your agents already holds, including
  ones the builder made for them. It reuses them by their exact id, so there's
  one `gmail.send_email`, not `email_marketing.send` and `email_dev.send`
  beside it, unless a different system or different safety limits are a real
  reason.
- **The catalogue** (`apps/server/src/catalog.ts`): common integrations (email,
  calendar, Slack, LinkedIn, accounting, GitHub, docs, CMS, web), each tool with
  a default tier. Most of the tools your existing agents use are in it too.
- **The fleet baseline**: plumbing every agent gets (tasks, requests, memory,
  its DM channel, booking its own follow-up run). The builder never needs to
  pick these.
- **New tools**, which the builder defines when nothing in the fleet or the
  catalogue does the job. Each one gets a name, a description, an input schema, a tier and a
  note on how it works.

## The files

Written to `apps/server/data/agents/<id>/` when you accept. That folder is
gitignored because it's per install.

- `CHARTER.md`: Mission, what it does, what it doesn't do, autonomy tier,
  guardrails, when to ask a person (through Requests or Approvals, never the DM
  channel), and what a good run looks like.
- `TOOLS.yaml`: `agent_id`, `model`, `servers`, `tools_allowed`, `tool_tiers`,
  `approval_windows`, `new_tools`, `limits.max_runs_per_day` (a runaway
  backstop, not the cadence: cadence is ferocity).
- `KPI.yaml`: the actions that count as output. These are the slices of the
  card's Output pie.
- `meta.json`: the card's details and set-up state (`ready`, `setting-up`,
  `generic`).

## Models

The builder uses Claude Opus 5.5 (`claude-opus-5-5`) with adaptive thinking
and structured outputs. If Claude declines a request, `fallbacks: "default"`
reruns it on Anthropic's recommended fallback model. The API key lives in
`apps/server/.env` (`ANTHROPIC_API_KEY`). That file is gitignored. Never paste
the key into the app or a chat.

## Still open

- **What "built" means for a new tool.** For now, building a tool means writing
  its full definition into TOOLS.yaml. Generating its code waits for the agent
  runtime, which doesn't exist yet.
- **Editing the organisation profile.** It's filled in once by the chat and
  added to by the builder; editing it directly belongs in the settings page.
- **Reused tools' definitions** live with the agent that first defined them. If
  that agent is deleted, the definition should move to one that still uses it.
