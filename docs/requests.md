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
   Agency Conductor  (tiny, cheap built-in agent)
        |-- a closely related agent can do it?  -> hand it over, write the answer, close
        |     e.g. SEO agent can't email -> partnerships marketing agent CAN email.
        |     Only genuinely related agents - NOT e.g. customer support for an
        |     outreach email.
        |
        |-- it's asking for a NEW TOOL / capability? -> Agency Engineer
        |
        v
   Agency Engineer  (built-in agent)
        |-- can build the tool? -> raise a HUMAN APPROVAL to create it
        |       approved -> build it, give it to the agent, close the request
        |       rejected / expired -> request goes to a person (below)
        |
        v
   Requests page  (a person)
```

When a request is closed by the Agency Conductor or the Agency Engineer, the agent is
told on its **next run**: the request was answered, and here's the answer /
the new tool. The Agency Engineer writes that note.

### When a request reaches a person

- it's too difficult, or isn't about a tool/agent at all
- the Agency Engineer's tool approval was rejected or expired
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

Every organization (and solo account) gets four built-in agents, owned by no
one and never deleted: the **Agency Engineer**, the **Agency Doctor**
(`runner/doctor.ts`), the **Agency Conductor** and the **Agency Reviewer**
(`runner/helpers.ts`). The Agency Conductor is separate so cheap rerouting
decisions don't spend a full engineering run. The Agency Doctor looks at the
whole fleet every two hours for what nobody files a request about - loops,
busywork, the same error again and again, asking what was already answered -
and gets each fixed through a note to the agent, closing the loop, a request
for the Agency Engineer, or a rule a person approves. Built-ins take no tasks
from other agents, and their actions on the fleet have levels in Settings >
Tools like any tool.

Each has a card on the dashboard with its three models (changeable), runs and
cost. The two helpers make one quick model call when the agency calls them
(`runner/quick.ts`), on their own models in order, and never run on a
schedule, so their cards have no Ferocity or Standby. Each call is a run: on
the card, in Usage, and as a post in the helper's DMs saying what it decided.
Those DMs are logs and take no messages. None of the three has a Stop of its
own: Stop agency on the dashboard covers them. While the agency is stopped,
requests wait for the Agency Engineer and plugins can't be proposed.

Models (`runner/defaults.ts`): a built-in with none gets three from what's
connected, on every tick, so connecting the first AI model sets them all.
The person's plans come first, then what suits the job (strong for the
engineer, cheap for the Agency Conductor, careful for the reviewer), then anything
else connected - DeepSeek, Mistral, Ollama, a custom provider - free ones
first. Models a person picked are left alone.

## The Requests page

A request shows here only once it needs you: the Agency Engineer asked you
something, handed it to you, or its go-live waits on your approval. While the
Agency Conductor or the engineer is still working it out, it isn't listed. Once
you've replied on one, it stays while the engineer works on your reply.

- Each request is owned by the owner of the agent that filed it. You see your
  own; org admins can switch to everyone's (same as Approvals).
- Long thin rows: one sentence of what the agent needs. Click to expand for
  the detail and the routing trail (what the Agency Conductor / Agency Engineer tried
  and why it ended up with you).
- Actions on an expanded request:
  - **Task Agency Engineer** - opens a conversation with the engineer inside
    the request. You can say what you're able to do ("I'll get a Sales
    Navigator seat - what do you need?"), it answers, you go do it, then reply
    "done" and it designs the tool with all that context.

    **Building the tool is always a human approval.** The engineer raises it
    ("Agency Engineer wants to build a new tool for Lead Finder: ...") and the
    request shows *Waiting on approval*. The approval belongs to the owner of
    the agent that asked (the Agency Engineer itself is owned by no one).
    Approved -> it builds the tool, says what it built, and the request
    closes. A new version of a live integration doesn't interrupt it:
    agents keep the live version (plugin code included) until the new one
    is approved. Rejected -> its draft integration is discarded, or, if it
    was a new version of a live one, the live version stays as it was;
    expired -> the draft stays. Either way it says so in
    the conversation and the request stays open.

    **Rule: the Agency Engineer always tells you what to do.** It never just
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
    `Requests.tsx`). Opens the IDE on the request with the agency's own MCP
    server (below). Nothing is posted on the request for it.
  - **DIY** - you did it yourself; write what you did / how it fixed it.
  - **Reject** - write why (optional). Anything the Agency Engineer drafted
    for it is discarded, with its go-live approval.

## Guiding people

The Agency Engineer knows every button on the Requests and Approvals screens so
it can steer confused people to the right one (e.g. "done" while it's waiting
on its build approval -> go to Approvals and press Approve). What it's told
about the UI lives in [fleet-engineer-ui-guide.md](fleet-engineer-ui-guide.md).

## Status (2026-10-29)

Real for real agents' requests: every request goes to the Agency Engineer
(`runner/engineer.ts`), a built-in agent run by the runner like any other,
owned by no one. It talks to the person in the request (the thread is kept on
the server), hands work to a related agent, builds integrations (docs/
integrations.md), or hands the request to the person. A request's stage shows
on its row: Agency Engineer, Waiting on you, Waiting on approval, Needs you.
Accepting an agent files a request for every tool its builder invented that
nothing provides yet.

The Agency Conductor (`runner/conductor.ts`) takes every request first: one quick
model call on its own models (Haiku on the person's Claude plan when there is
one) hands it to
an agent that already does this as part of its job - as a task, closing the
request - and sends anything else, or anything it's unsure of, to the Fleet
Engineer. Requests for tools the builder invented go straight to the engineer.

Send to your IDE (`runner/ide.ts`): the request's folder gets REQUEST.md and an
MCP config for the agency's MCP server. Claude Code and Codex start in a
terminal on the task; Cursor and Antigravity open the folder.

**The agency's MCP server** (`runner/agency-mcp.ts`): everything the Fleet
Engineer and the agent builder can do, for the person's own AI IDE - requests
(list, answer), agents (read, edit CHARTER/TOOLS/KPI, models, ferocity and
state, create, delete, run or message), integrations (list, read, draft,
plugins, test, publish, give tools, discard) and what's waiting in Approvals
(read-only). It acts for the person, so nothing queues in the app: the IDE
asks them before each call. A plugin still gets the security review and runs
sandboxed; built-in agents can't be edited or stopped. One address on this
computer, kept across restarts (Settings -> Connectors -> Your IDE copies it,
or Claude Code's `claude mcp add` command). Agents made from it belong to the
host.

The person can also simply message the Agency Engineer in its DM channel.
