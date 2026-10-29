# Requests: how an agent asks for something it can't do

An agent that's missing something it needs for its work (a tool, access, a
file, a decision) files a **resource request**. Most requests should be
settled inside the agency without a person ever seeing them; the Requests page
is the last stop, not the first.

## Routing

```
agent files request
        |
        v
   Conductor  (tiny, cheap built-in agent)
        |-- a closely related agent can do it?  -> hand it over, write the answer, close
        |     e.g. SEO agent can't email -> partnerships marketing agent CAN email.
        |     Only genuinely related agents - NOT e.g. customer support for an
        |     outreach email.
        |
        |-- it's asking for a NEW TOOL / capability? -> Fleet Engineer
        |
        v
   Fleet Engineer  (built-in agent)
        |-- can build the tool? -> raise a HUMAN APPROVAL to create it
        |       approved -> build it, give it to the agent, close the request
        |       rejected / expired -> request goes to a person (below)
        |
        v
   Requests page  (a person)
```

When a request is closed by the Conductor or the Fleet Engineer, the agent is
told on its **next run**: the request was answered, and here's the answer /
the new tool. The Fleet Engineer writes that note.

### When a request reaches a person

- it's too difficult, or isn't about a tool/agent at all
- the Fleet Engineer's tool approval was rejected or expired
- it has been rerouted too many times (rerouting costs runs of several agents,
  so it's capped rather than allowed to bounce around)

## Ferocity and requests

An agent's ferocity sets how hard it works **and how much it asks for**. Low
ferocity makes do; high ferocity hunts for anything that would get more done.
Example - an outreach agent that already has a LinkedIn connection:

| Ferocity | Asks for... |
|---|---|
| Chill | An email box only if it literally has no way to reach anyone. Has LinkedIn, so it just uses that. |
| Steady | An email box too - "it would make me much more effective". |
| Driven | Email, plus enrichment data or a second channel with a clear payoff. |
| Relentless | Anything that removes a limit on output. |
| Apocalyptic | WhatsApp, SMS, phone calls, every channel it can think of - whatever gets more outreach done. |

Apocalyptic is the paperclip maximiser **inside a fence**: the agent can want
everything, but it can only *ask*. Every new tool, channel or access still has
to come through a request (rerouted, built behind a human approval, or decided
by a person), so its appetite never turns into capability on its own.

Each level's instruction text lives with the level itself (`FEROCITY[].requestStance`
in `apps/desktop/src/data.ts`) so it's ready to drop into the agent's run
instructions. Like the schedules there, the wording is a first draft.

## Built-in agents

Every organization (and solo account) gets three built-in agents, owned by no
one and never deleted: the **Fleet Engineer**, the **Conductor** and the
**Security Reviewer** (`runner/helpers.ts`). The Conductor is separate so cheap
rerouting decisions don't spend a full engineering run.

Each has a card on the dashboard with its three models (changeable), runs and
cost. The two helpers make one quick model call when the agency calls them
(`runner/quick.ts`), on their own models in order, and never run on a
schedule, so their cards have no Ferocity or Standby. Each call is a run: on
the card, in Usage, and as a post in the helper's DMs saying what it decided.
Those DMs are logs and take no messages. None of the three has a Stop of its
own: Stop agency on the dashboard covers them. While the agency is stopped,
requests wait for the Fleet Engineer and plugins can't be proposed.

Models (`runner/defaults.ts`): a built-in with none gets three from what's
connected, on every tick, so connecting the first AI model sets them all.
The person's plans come first, then what suits the job (strong for the
engineer, cheap for the Conductor, careful for the reviewer), then anything
else connected - DeepSeek, Mistral, Ollama, a custom provider - free ones
first. Models a person picked are left alone.

## The Requests page

- Each request is owned by the owner of the agent that filed it. You see your
  own; org admins can switch to everyone's (same as Approvals).
- Long thin rows: one sentence of what the agent needs. Click to expand for
  the detail and the routing trail (what the Conductor / Fleet Engineer tried
  and why it ended up with you).
- Actions on an expanded request:
  - **Task Fleet Engineer** - opens a conversation with the engineer inside
    the request. You can say what you're able to do ("I'll get a Sales
    Navigator seat - what do you need?"), it answers, you go do it, then reply
    "done" and it designs the tool with all that context.

    **Building the tool is always a human approval.** The engineer raises it
    ("Fleet Engineer wants to build a new tool for Lead Finder: ...") and the
    request shows *Waiting on approval*. The approval belongs to the owner of
    the agent that asked (the Fleet Engineer itself is owned by no one).
    Approved -> it builds the tool, says what it built, and the request
    closes. Rejected -> its draft integration is discarded (one that has
    been live is kept); expired -> the draft stays. Either way it says so in
    the conversation and the request stays open.

    **Rule: the Fleet Engineer always tells you what to do.** It never just
    explains why it can't do something. If it can't finish on its own, its
    reply is the steps that would unblock it (buy this, create that key, tell
    me which file is current) and what it will do once they're done. Secrets
    (API keys, passwords) never go in the conversation - they go in settings.

    **It decides, builds, then tells you.** It never asks whether to set
    something up: it writes the draft and says it's ready for your key, with
    a sentence or two on why it's the best way and numbered steps. No account
    of its research or list of alternatives unless you ask. If you don't want
    it, reply or reject the request.
  - **Send to your AI IDE** - one button named and branded for the IDE you
    use ("Send to Claude Code" with Claude's logo, Cursor's for Cursor...).
    Which IDE is a setting in the config menu (for now `YOUR_IDE` in
    `Requests.tsx`). *Not built yet*. Finds the IDE you use, opens it and places a prompt in it.
    Needs a proper connector, and the IDE needs this system's MCP so it can read
    requests and create tools directly. The point is off-platform work the
    agency can't do itself (e.g. changing settings on your computer).
  - **DIY** - you did it yourself; write what you did / how it fixed it.
  - **Reject** - write why (optional). Anything the Fleet Engineer drafted
    for it is discarded, with its go-live approval.

## Guiding people

The Fleet Engineer knows every button on the Requests and Approvals screens so
it can steer confused people to the right one (e.g. "done" while it's waiting
on its build approval -> go to Approvals and press Approve). What it's told
about the UI lives in [fleet-engineer-ui-guide.md](fleet-engineer-ui-guide.md).

## Status (2026-10-29)

Real for real agents' requests: every request goes to the Fleet Engineer
(`runner/engineer.ts`), a built-in agent run by the runner like any other,
owned by no one. It talks to the person in the request (the thread is kept on
the server), hands work to a related agent, builds integrations (docs/
integrations.md), or hands the request to the person. A request's stage shows
on its row: Fleet Engineer, Waiting on you, Waiting on approval, Needs you.
Accepting an agent files a request for every tool its builder invented that
nothing provides yet.

The Conductor (`runner/conductor.ts`) takes every request first: one quick
model call on its own models (Haiku on the person's Claude plan when there is
one) hands it to
an agent that already does this as part of its job - as a task, closing the
request - and sends anything else, or anything it's unsure of, to the Fleet
Engineer. Requests for tools the builder invented go straight to the engineer.

Send to your IDE (`runner/ide.ts`): the request's folder gets REQUEST.md and an
MCP config giving the IDE the Fleet Engineer's tools, so its work still goes
through drafts, the review and the person's approval. Claude Code and Codex
start in a terminal on the task; Cursor and Antigravity open the folder.

The person can also simply message the Fleet Engineer in its DM channel.
