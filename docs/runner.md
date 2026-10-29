# The runner: how agents actually run

The design, agreed 2026-10-28. Step 1 (below) is built: `apps/server/src/runner/`. Modelled
on the WAR agency runner, keeping what worked there and building in its
lessons from day one (see "From WAR" at the end).

## Ferocity sets how hard an agent works

Five levels. The agent builder sets each agent's numbers for its job when it
builds it (packs get theirs when they're customised). The multiples below are
the guide the builder works from, not fixed formulas.

| Level | Schedule (builder sets) | Re-running itself | Minimum output per run | Every run also... |
|---|---|---|---|---|
| **Chill** | What gets the job done: bug triage 2x a day, outreach daily, an ISMS policy check weekly | Allowed, but told not to once its work is done | None | - |
| **Steady** | About 1.5x Chill | Encouraged when there's work left | None | - |
| **Driven** | About 2x Chill | Encouraged | Soft floor: **one** gentle nudge if a run ends with very little output | Looks for better ways to do its job, new tools and wider scope, and files requests for them. A run that doesn't is doing it wrong |
| **Relentless** | About 4x Chill | Strongly encouraged | High floor (builder sets), up to 4 nudges | Same as Driven |
| **Apocalyptic** | None: the next run starts as soon as one ends | Always (the runner books it) | Deliberately out of reach (builder sets); 4 nudges, then the run ends with whatever it made, and the next run starts | Same as Driven |

How much each level **asks for** (resource requests) is in
[requests.md](requests.md), "Ferocity and requests".

Everything the builder sets lives in the agent's TOOLS.yaml under `ferocity:`
(one entry per level: schedule, floor, and for Driven the soft-floor
threshold), so changing an agent's level on its card changes its behaviour
straight away, without a rebuild.

## When more of the main action isn't better

Some jobs have a natural limit: an agent that changes the desktop wallpaper
every morning gets the job done on Chill, and at Relentless or Apocalyptic
must not "produce output" by changing it every few minutes. Setting it that
high is the person's call; the builder still makes it do something useful:

- **Natural limits on actions.** The builder can cap any action by what the
  job needs (`set_wallpaper`: at most once a day). The runner enforces it at
  every ferocity and refuses a call past it with a reason that points the agent
  at its other work ("Already done today. Put your effort into what's next").
- **What extra effort means, per agent.** For each level above Chill, the
  builder writes what more output looks like for this job and which actions
  count toward its floor there. Wallpaper agent at Apocalyptic: stockpile and
  rate candidate images and jokes for future mornings, plan themes, and file
  requests asking what the person likes - its floor is met by building that
  library, never by changing the wallpaper again.
- **Refused calls don't count.** An action refused by a natural limit doesn't
  count toward the floor, or an agent could meet it by hammering the same
  refused call. (Actions waiting in Approvals still count, as above.)

## One run

- One run = one conversation with the model and its tool loop, using the
  agent's first working model (fallback and backoff: model-connections.md).
- **One run at a time per agent.** A scheduled run that comes due while one is
  going is skipped, not queued.
- Triggers: its schedule, booking itself, Apocalyptic's run-after-run, another
  agent handing it a task, a person messaging it, an approval being decided.
- A run that answers **a person's message** is never nudged past its answer.
- At the end, the run posts to the agent's DM channel (docs/agent-dms.md).

## Minimum output (the floor) and nudges

- What counts is the agent's output actions (KPI.yaml). An action counts **when
  the agent tries it**, including a T2 action that's now waiting in Approvals,
  and including one that fails. Batch actions count once per item (one
  `queue_leads` with 5 leads = 5). A call refused by a natural limit doesn't
  count (see "When more of the main action isn't better").
- When a run would end below its floor, the runner sends one more message in
  the same conversation, so nothing it already found is lost:

  > Not finished. This run has made N output action(s); the floor for every
  > run is M. Carry on now: (the agent's own hint - where else to look).
  > Keep going until you reach M, then write your summary. (Continuation k of 4.)

- After the last nudge the run just ends. What it made stands; nothing is
  forced or marked failed. At Apocalyptic the next run starts straight away.
- Driven's soft floor is a single nudge, worded gently.

## Re-running itself

- A built-in tool lets an agent book its own next run, with a reason and a
  delay. Whether it's encouraged depends on its ferocity (table above).
- At Apocalyptic the runner books the next run itself.
- Old idle summaries are not evidence: a past "nothing to do" run is never
  fed back as a reason to stop.

## Agent memory

Each agent keeps its own memory between runs. Separate from the person and
organisation memory profiles (org.ts), which say who it works for; this is
what the agent itself has learned doing the job.

The failure to design out (it happened repeatedly at WAR): an agent tries a
tool ten times and writes "doesn't work" ten times; someone fixes the tool;
the agent uses it and notes "works"; next run it sees ten failures against one
success, decides the tool is broken and complains again. Telling the model
"prefer recent memories" isn't enough on its own - volume wins - so:

1. **Tool status never comes from memory.** The runner sees every tool call
   succeed or fail, so it gives each run the live facts up front ("send_email:
   last worked 2 hours ago"). Agents are told never to record a tool failure
   in memory: a tool that doesn't work gets a resource request, and the agent
   is told when it's fixed.
2. **Newest wins.** Memories are kept as written - nothing is replaced when a
   new one is added - and given newest first, each with its age ("3 days
   ago"). The run instructions say a newer memory overrides an older one it
   disagrees with.
3. **A cap, with compaction.** Each agent's memory has a size cap. Past it,
   the oldest memories are summarised into a dated block ("Earlier, Jan-Mar:
   ...") that ranks below anything recent and leaves out anything a newer
   memory contradicts. Stored on the host, never a growing pile of files.
4. **Idle runs teach nothing.** A run that found nothing to do isn't written
   down as a lesson.

## Standby and Stop (agreed 2026-10-29)

| | Standby | Stop |
|---|---|---|
| The run it's in | finishes | cut short ("stopped", not a failure: no backoff) |
| Its schedule, Apocalyptic chaining, its own bookings, handoffs | no | no |
| A person's message, Run now | runs | waits until it's turned back on |
| Hearing how an approval it queued was decided | runs | waits |
| Its approvals | as normal | stay, greyed out with a Stopped label, undecidable; their expiry keeps counting |
| Its card | keeps its colours, stops moving | fades to grey |

Standby is `draining` in the runner's store. Both last until someone resumes the agent; nothing turns one into the
other. The cards and approvals follow the runner, so a change made by
someone else (or another device) shows within seconds.

**Stop agency** (next to the time range on the dashboard) is Stop for every
agent at once, built-ins included - they have no Stop or Standby of their
own. Each agent keeps its own state underneath, so Resume agency puts every
one back as it was. While it's stopped, the cards' own controls wait.

**A restart mid-run**: a run the app's restart cut short is booked again
(except scheduled ones, which simply come round again) and carries on: its
opening says what it already did, so nothing is done twice.

## Money and limits

- **Plans run out**: the agent moves on to its 2nd and 3rd models, even onto
  pay-per-use keys, and keeps going.
- **Spend caps** (Settings -> Usage): an optional daily dollar cap for the
  whole organisation, and an optional daily cap per agent. Hitting one pauses
  that spending until the next day; plans and local models aren't affected.
- **What a run cost**: OpenRouter's public price list, refreshed daily. A
  run on a plan (Claude Code, ChatGPT) is priced as the same model on an API
  would be - more than it really costs, but it shows what the plan is worth,
  and counts toward spend caps (keeping them on the safe side). Copilot picks
  its own model, so its runs are unknown; local models are free.
- **Failure backoff**: an agent whose runs keep failing within seconds (broken
  model, broken tool) backs off instead of spinning, at every level.
- `max_runs_per_day` is only a runaway backstop, never the pace. Built-ins
  have none: their work comes from requests, and failure backoff still
  stops one that keeps failing.
- **Days are the host's** (`runner/clock.ts`): "today" for spend caps and run
  limits, the month in Usage, and the date agents are told start at the
  host's midnight, not the server's. The host's app sends its time zone the
  first time it opens (`host_timezone`); until orgs exist, whoever runs the
  app is the host.

## Edge cases settled

- **Handing work over**: never to an agent that's stopped or on standby - it
  wouldn't start on it. The Conductor leaves them out (the request goes to
  the Fleet Engineer), and `tasks.delegate_task` refuses with why.
- **Built-ins' models**: when none of a built-in's models is connected any
  more (Claude Code disconnected, say), it gets three from what is.
- **Deleting an agent** (`runner/forget.ts`): its pending approvals and the
  Fleet Engineer's for it are rejected, its open requests turned down (their
  drafts discarded), its bookings dropped, work handed to it closed as not
  done (so whoever handed it over hears), and its DMs, memory and state
  removed. Its runs stay, so Usage still adds up.

## Building it: one piece at a time

Build, stop, test with real agents at each ferocity, then move on:

1. **The runner and the built-in agency tools** - agent memory (as above),
   agent DMs, resource requests, booking its own run, handing tasks to other
   agents.
2. **Web research** - search, fetching pages, browsing.
3. **Email (Gmail)** - reading, drafting, sending (T2).
4. **Code / GitHub** - repos, issues, pull requests.

Technical choices: our own tool loop for API-key providers; Claude Code and
Copilot get the agent's tools through an MCP server (Claude Code runs
isolated, as in model-connections.md); runs, actions and spend stored in
SQLite on the organisation's host.

## Status (2026-10-29)

Step 1 is built and tested:

- **Runs on every connection**, tested live: a two-turn tool loop on all ten
  API-key and plan providers, runs handed between providers mid-way, and
  whole runs through Claude Code and Copilot (isolated, the agent's tools only).
- **Ferocity**: schedules per level, Apocalyptic back to back, floors with
  nudges (tested with a scripted model; live, stating the floor alone got
  real models past it - 64 actions against a floor of 60 on Claude Code).
- **Built-in tools**: memory, its own workspace, requests, tasks and
  handoffs, booking its next run. Natural limits, T2 queued for approval.
- **Approvals**: a T2 call is queued with its exact arguments and the run
  carries on. Approved on the Approvals page, it runs then and there
  (exactly once); rejected (with your note) or expired, it never does.
  Either way the agent gets a run to hear the outcome.
- **Every run opens with today's date and time**: models don't know it, and
  research, dating work and "this year" need it.
- **In the app**: real agents' cards (state, stats, ferocity, Standby/Stop,
  Run now), DM channels, requests (your DIY/Reject answer reaches the agent),
  daily spending limits in Settings -> Usage.
- **The builder** writes each agent's ferocity plan and natural limits.
  First real one: "Morning Wallpaper" capped its wallpaper change at once a
  day and put higher-level effort into stocking ideas, as designed.

Not yet:

- An agent that falls from a free plan to a paid model (its plan failing)
  does it silently; it should say so in its DMs.

Tested live since (2026-10-29): memory compaction on a plan (it had been
skipping Claude Code and Copilot), spend caps (a paid-only agent over the
limit doesn't run, and says which limit; one with a plan runs on the plan),
and prices for DeepSeek, Groq and OpenRouter's aliases. The Conductor and
the Fleet Engineer run (docs/requests.md).

## From WAR (what its runner taught us)

- The floor works: its SEO agent went from one or two searches a run to real
  volume. Its nudge wording is the model for ours.
- Runaway chaining: an agent that always booked its next run hit 120-130 runs
  a day; another booked ~25 runs in one night; resume loops burned 24 runs in
  24 minutes. Hence one run at a time, failure backoff, and the backstop.
- Idle runs fed back as learnings taught an agent nothing was ever due.
- A crash retry that replays the whole conversation can repeat actions that
  already ran - so a retry must never re-send an action.
- T2 actions don't pause a run: the agent is told the action is queued and
  carries on; an approval later resumes it.
