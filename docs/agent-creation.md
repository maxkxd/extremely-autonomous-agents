# Agent creation

How a new agent gets made. It's modelled on the WAR agency runner: every agent
is a **Charter** (what it's for and how it behaves) plus a **TOOLS.yaml** (what
it can touch, and which actions need a person's OK) plus a **KPI.yaml** (which
actions count as its output). The person creating the agent never sees any of
these files. They describe what they want, in a conversation, and the agent
builder writes the files.

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

## Tiers

Three tiers, the same as the runner minus T3:

| Tier | What happens | Used for |
|---|---|---|
| T0 | Just runs | Reads, searches, browsing, its own scratch files: anything that would be pure noise to log |
| T1 | Runs, and a notice lands in the agent's DM channel | Reversible internal writes: records, drafts, labels, tasks, notes to other agents |
| T2 | Waits in **Approvals** until a person decides; expires if nobody does | Anything visible outside the organisation or hard to undo: sending, posting, publishing, paying, deleting |

There's no "never" tier. If a tool isn't in TOOLS.yaml, the agent can't call
it. Leaving a tool out is how you forbid it.

Every T2 tool gets an approval window (how long it waits) and what happens when
it runs out: always `expire`. An action nobody reviewed in time doesn't run
unattended.

## Where tools come from

- **The catalogue** (`apps/server/src/catalog.ts`): common integrations (email,
  calendar, Slack, LinkedIn, accounting, GitHub, docs, CMS, web), each tool with
  a default tier. Most of the tools your existing agents use are in it too.
- **The fleet baseline**: plumbing every agent gets (tasks, requests, memory,
  its DM channel, booking its own follow-up run). The builder never needs to
  pick these.
- **New tools**, which the builder defines when nothing in the catalogue does
  the job. Each one gets a name, a description, an input schema, a tier and a
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
- **Adding a pack.** What the pack card's Add button does isn't designed yet.
