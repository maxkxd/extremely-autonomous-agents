# The runner: how agents actually run

The design, agreed 2026-10-28. Step 1 (below) is built: `apps/server/src/runner/`. Modelled
on the WAR agency runner, keeping what worked there and building in its
lessons from day one (see "From WAR" at the end).

## Ferocity sets how hard an agent works

Five levels. Every agent starts on **Steady**, the default (until 18 Nov 2026
that was Chill's behaviour; the old Steady, a little more often, was dropped,
and agencies from before move their Chill agents to Steady once). The built-in
agents have no level and keep their own schedules. The agent builder sets each agent's numbers for its job when it
builds it (packs get theirs when they're customised). The multiples below are
the guide the builder works from, not fixed formulas.

| Level | Schedule (builder sets) | Re-running itself | Minimum output per run | Every run also... |
|---|---|---|---|---|
| **Chill** | None: it runs only when given work - a task, an answered request, another agent's hand-off, a person's message, an event it watches for. Close to standby, except that everything that hands it work still wakes it | To finish what it was given, yes; never to start new work of its own | None | - |
| **Steady** (the default) | What gets the job done: bug triage 2x a day, outreach daily, an ISMS policy check weekly | Allowed, but told not to once its work is done | None | - |
| **Driven** | As often as there's usually new work to find | Encouraged | Soft floor: **one** gentle nudge if a run ends with very little output | Looks for better ways to do its job, new tools and wider scope, and files requests for them. A run that doesn't is doing it wrong |
| **Relentless** | Set by the job, not by Steady: a stream of fresh work (lead research) every 10-30 min; event-driven work (bug triage on a Sentry alert) an idle sweep every 6-8 h, woken by its events. Very high effort, not constant runs | Strongly encouraged; woken by an event, it follows it to the bottom and books follow-ups | High floor (builder sets), up to 4 nudges | Same as Driven |
| **Apocalyptic** | None: the next run starts as soon as one ends (a 20-second breath). Each run in a row that falls short of its target makes the next wait a little longer, growing until about 20 short runs have it at Relentless's pace; one run that reaches its target and it's back to back again | Always (the runner books it) | Deliberately out of reach (builder sets); 4 nudges, then the run ends with whatever it made, and the next run starts | Same as Driven |

An agent runs at its level whether or not the tools its output is counted by are
connected yet: a new agent waits for its setup stopped, so one running without
them was resumed on purpose. At most 32 agents run at once (the Agency Engineer's
extra runs on different requests don't count).

How much each level **asks for** (resource requests) is in
[requests.md](requests.md), "Ferocity and requests".

Everything the builder sets lives in the agent's TOOLS.yaml under `ferocity:`
(one entry per level: schedule, floor, and for Driven the soft-floor
threshold), so changing an agent's level on its card changes its behaviour
straight away, without a rebuild.

## Goals set the pace (the `goals` branch)

On this branch nobody chooses a level, anywhere: not on the card, not the agent in its chat,
not through the MCP server. Each agent has goals: an output in plain words, an amount and a
period - an hour, a day, a week, a month or a year ("emails sent: 100 a day", "posts
published: 5 a week"). A goal is one of its KPI labels, so what counts toward it is exactly
the actions under that label (`runner/goals.ts`). The levels above remain only as the
built-in agents' Steady and as the tone an agent is told in.

- **A goal is mandatory.** An ordinary agent with no goal (no output with a number) does
  not run: no schedule, no bookings started, no Run now. Only a person's message is still
  answered. The builder gives every new agent at least one KPI row with an `amount` of 1 or
  more and its `period` - a sensible basic number, asked of the person only when it really
  matters to them - and a build without one is refused. Nothing may take the last number
  away: setting the only goal to 0, or renaming or dropping the output that holds it, is
  refused (a renamed label takes its goal along).
- **Agents from before** with no goal wait: the scheduler files one request to the Agency
  Engineer for each, which reads its Charter and KPI and sets a basic number
  (`engineer.set_goal`). The request closes by itself once the agent has a goal.
- **Setting one.** On the card: the amount and period beside the goal. An agent changes its
  own when its person asks (`ops.set_my_goal`). A new kind of goal ("build backlinks too")
  is the Agency Engineer's (`engineer.set_goal`): the label, and the tools whose calls
  count. KPI rows written before periods carry `per_day`, read as an amount a day.
- **What counts.** An action as soon as it is done or drafted (queued for approval), within
  a trailing window: the last hour, 24 hours, 7 days, 30 days or 365 days. There is no
  calendar or time-zone boundary (not "by midnight", not "this week from Monday"). A draft
  a person rejects, withdraws or lets expire comes off again, so an agent at its goal can
  drop back under it.
- **The pace.** Worked out fresh, goal by goal, as a steady rate of the amount over that
  window (100 a day is 100 / 24 hours, even at 11pm with 90 still to go). Those rates are
  added together and give how often it runs, how many runs of it go at once (up to 20; the
  scheduler starts them, each told to take a different slice) and what each run is asked
  for. Never slower than its ordinary schedule. At its goal it eases off to that schedule.
  It is never stopped for reaching it.
- **The Agency Conductor.** Every half hour it looks over every agent with a goal in one
  cheap call and may change an agent's numbers or leave it a line of advice. Its numbers
  are kept in bounds and hold for 45 minutes; if the call fails the arithmetic stands.
- **The effect level** (0-4: the card's glow, twitch and red, and the tone of what the
  agent is told) comes from the estimated runs a day at its pace: up to 2 is 0, up to 12 is
  1, up to 48 is 2, up to 200 is 3, more is 4. It moves by itself whenever the pace does,
  the Conductor's changes included.
- **What the agent is told.** Its goals, the count so far in each one's window ("70 of 100
  in the last 24 hours", "64 of 150 in the last 7 days"), that it runs many times, and what this run owes.
- **Runs that make nothing** are not multiplied: after five in a row it drops to one run an
  hour and is told to find what is in the way.

## When more of the main action isn't better

Some jobs have a natural limit: an agent that changes the desktop wallpaper
every morning gets the job done on Steady, and at Relentless or Apocalyptic
must not "produce output" by changing it every few minutes. Setting it that
high is the person's call; the builder still makes it do something useful:

- **Natural limits on actions - only ones a person asked for.** The builder
  caps an action only when the person said so in their own words
  (`set_wallpaper`: "at most once a day"); it and the Agency Engineer never add
  one because it seems sensible. The runner enforces it at every ferocity and
  refuses a call past it with a reason that points the agent at its other work.
  When a person asked for the blocked action, the agent tells them a limit
  stopped it and that the Engineer can lift it: `engineer.set_limits` changes
  or removes an agent's limits, on a person's word only.
- **What extra effort means, per agent.** For each level above Steady, the
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
- **One main run at a time per agent.** A scheduled run that comes due while one is
  going is skipped, not queued.
- **Parallel runs, at every level.** An agent with several independent pieces of
  work (one launch film per business) starts a run of itself for each
  (`ops.start_parallel_run`), up to 7 beside its main run. Every level can; the
  higher the level, the harder its instructions push it to (Apocalyptic: every
  independent piece gets its own run). Each is told its one piece and to leave the others alone, and can't
  start more. They're the agent's own runs (same tools, files, memory), so their cost
  and output count as the agent's. The memory brake still holds new ones back.
- Triggers: its schedule, booking itself, Apocalyptic's run-after-run, another
  agent handing it a task, a person messaging it, an approval being decided.
- **Every event wake is debounced** (`runner/wakes.ts`): handoffs, requests,
  replies, results, approvals, events, connections. A wake is due a settle
  after the latest event and no later than a max after the first: 60 s / 5 min
  by default, 45 s / 10 min for approvals, 8 s / 30 s for a person's DM. While
  one is waiting, a new event joins it (any kind, each under its own heading in
  the run's opening) instead of booking another run; a DM joins only the same
  person's waiting DMs. Past 12,000 characters, a pointer to where the rest is
  listed. Run now, its schedule and runs it booked itself aren't debounced.
- A run that answers **a person's message** is never nudged past its answer.
- At the end, the run posts to the agent's DM channel (docs/agent-dms.md).

## Minimum output (the floor) and nudges

- What counts is the agent's output actions (KPI.yaml). An action counts **when
  the agent tries it**, including a T2 action that's now waiting in Approvals,
  and including one that fails. Batch actions count once per item (one
  `queue_leads` with 5 leads = 5). A batch a service wraps in `body`
  (`{ data: [ ...records ] }`, or that JSON in a string) counts once per
  record too. A call refused by a natural limit doesn't
  count (see "When more of the main action isn't better").
- The id in KPI.yaml is the tool that actually runs. A catalogue name
  (`crm.create_record`) counts nothing once a connection's own tool
  (`acme-crm.createrecords`) has replaced it. When an MCP server goes live,
  a count whose name is that same action is moved onto the real tool; one
  that doesn't match is left for the Agency Engineer
  (`engineer.retarget_output`). An MCP server's tool names stay as the
  server gave them.
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
5. **A change of how it works goes into its Charter, not its memory.** A person
   telling an agent in its chat to work differently from now on ("lead with
   premium, never the free offer") is filed with `requests.change_my_instructions`.
   The Agency Engineer rewrites the whole Charter so nothing in it says
   otherwise, with the person's wish winning, and no approval is asked: they
   asked for it. `engineer.rewrite_instructions` writes it, closes the request
   and wakes the agent. A tool the change needs is handled as a missing tool.
   The agent works the new way at once, without waiting for the rewrite.
   A person can also ask the Agency Engineer in its chat to change an agent
   (its maker, or an owner or admin: `runner/charter.ts` `askerMayChange`).
   Every rewrite keeps the Charter it replaces (`charter-versions/`, the last
   10); `engineer.read_agent` lists them and `engineer.restore_instructions`
   puts one back when a person asks to undo a change. The Engineer always reads
   the whole Charter, however long.
6. **A person can change an agent's settings from its chat.** "Slow down", "stop
   until Monday", "only on weekdays", "use Claude for this": the agent sets them
   itself (`runner/selfsettings.ts`: `ops.set_my_goal`, `ops.pause_me` with an
   optional time it comes back on by itself, `ops.set_my_run_days`,
   `ops.set_my_models`). A person resuming or stopping it on the card overrides a
   pause it set. A note on a rejected action goes into its memory if it's for now,
   into its instructions if it's for good.

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

**The whole agency** (next to the time range on the dashboard) has the same
pair, over every agent at once, built-ins included - they have none of their
own. Each agent keeps its own state underneath, so resuming puts every one
back as it was, and while the agency is held the cards' own controls wait.

- **Standby**: every agent as if on standby - nothing starts by itself, a
  person is still answered, approvals are still heard. Building agents and
  tailoring packs go on.
- **Stop**: every run cut short and nothing at all: no runs, no agent
  builder chat, and a pack's tailoring waits (its agents exist, untailored,
  until the agency is resumed or put on standby).

**A restart mid-run**: a run the app's restart cut short is booked again
(except scheduled ones, which simply come round again) and carries on: its
opening says what it already did, so nothing is done twice.

## Money and limits

- **Plans run out**: the agent moves on to its 2nd and 3rd models, even onto
  pay-per-use keys, and keeps going.
- **Spend caps** (Settings -> Usage): an optional monthly dollar cap for the
  whole organisation, and an optional monthly cap per agent (the host's
  calendar month). Hitting one pauses that spending until the next month;
  plans and local models aren't affected.
- **What a run cost**: OpenRouter's public price list, refreshed daily. A
  run on a plan is priced as the same model on an API would be - more than it
  really costs, but it shows what the plan is worth, and it counts toward the
  spend limits. Claude Code reports that figure itself (cache reads at their
  own price); a ChatGPT plan run is priced from its tokens. Copilot doesn't
  say what it used, so its runs are unknown; local models are free. Plans
  keep running past a spend limit either way.
- **Failure backoff**: an agent whose runs keep failing within seconds (broken
  model, broken tool) backs off instead of spinning, at every level.
- **Going round in circles** (`loopGuard` in `runner/run.ts`): a run has no
  length or turn limit, but one that makes the exact same tool call (same
  arguments) 300 times in a row, each failing or producing no output, is ended
  as failed with that reason, so failure backoff applies. Any output, or any
  different call, starts the count again: output is never cut short. The model's health isn't
  marked down for it. A run on a plan with its own loop (Copilot) has its
  further calls refused and is ended when that loop returns.
- **Runaway backstop**: at most 1,000 runs a day for an agent at Chill, Steady
  or Driven, none at Relentless and Apocalyptic - never the pace. A person's
  message and Run now aren't held by it. Built-ins have none: their work comes
  from requests, and failure backoff still stops one that keeps failing.
  (TOOLS.yaml's `limits.max_runs_per_day` is kept but no longer used.)
- **Days are the host's** (`runner/clock.ts`): "today" for spend caps and run
  limits, the month in Usage, and the date agents are told start at the
  host's midnight, not the server's. The host's app sends its time zone the
  first time it opens (`host_timezone`); until orgs exist, whoever runs the
  app is the host.

## Edge cases settled

- **Handing work over**: never to an agent that's stopped or on standby - it
  wouldn't start on it. The Agency Conductor leaves them out (the request goes to
  the Agency Engineer), and `tasks.delegate_task` refuses with why.
- **A setup item the person doesn't use**: its Suggest alternative button opens
  the request with the reply box ready. A reply - or a reject with a reason - goes
  to the Agency Engineer, which works on that same request (a turned-down one is
  picked back up) and can rename the card's item (`setup_name`) to what the
  person will really connect. No separate flow: the card follows the requests.
- **Hand-offs are visible**: a hand-off and its result each put a line in both
  agents' chats ("Asked Price Watch: ...", "Price Watch finished: ..."), for
  everyone in the organization to read.
- **Built-ins' models**: when none of a built-in's models is connected any
  more (Claude Code disconnected, say), it gets three from what is.
- **Deleting an agent** (`runner/forget.ts`): its pending approvals and the
  Agency Engineer's for it are rejected, its open requests turned down (their
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
  Either way the agent gets a run to hear the outcome - one run for a batch:
  outcomes gather for 45 seconds after the last decision (at most 10 minutes
  from the first), so approving 50 at once wakes it once.
- **When approved actions run** (`runner/action-queue.ts`): straight away by
  default, one at a time per agent, tool and account, every account at once.
  No pace is forced. The agent can choose to space them out, with a reason
  shown on the action: `approvals.pace_mine` before a batch is approved (cold
  email from one mailbox), `approvals.schedule_mine` for ones approved and
  not run yet (now, later, spread over a time per account, or cancel), and
  `approvals.queue_mine` to see them, recent sends per account and failures.
  Each is a row with its due time, so a restart keeps the schedule. One that
  fails pauses the rest on that account, holds new approvals for it, and
  wakes the agent once to decide: a burst tripping a sending limit isn't a
  broken tool. One running when the agency stopped is never run again by
  itself; its agent is told it may or may not have happened. A person can
  still run any of them now (`POST /api/runner/approvals/run-now`).
- **Every run opens with today's date and time**: models don't know it, and
  research, dating work and "this year" need it.
- **In the app**: real agents' cards (state, stats, ferocity, Standby/Stop,
  Run now), DM channels, requests (your DIY/Reject answer reaches the agent),
  monthly spending limits in Settings -> Usage.
- **The builder** writes each agent's ferocity plan and natural limits.
  First real one: "Morning Wallpaper" capped its wallpaper change at once a
  day and put higher-level effort into stocking ideas, as designed.

Not yet:

- An agent that falls from a free plan to a paid model (its plan failing)
  does it silently; it should say so in its DMs.

Tested live since (2026-10-29): memory compaction on a plan (it had been
skipping Claude Code and Copilot), spend caps (a paid-only agent over the
limit doesn't run, and says which limit; one with a plan runs on the plan),
and prices for DeepSeek, Groq and OpenRouter's aliases. The Agency Conductor and
the Agency Engineer run (docs/requests.md).

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
