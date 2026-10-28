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

Every organization (and solo account) gets the **Conductor** and the **Fleet
Engineer** by default. They're separate only so cheap rerouting decisions don't
spend a full engineering run; **on the dashboard they appear as one agent: Fleet
Engineer**.

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
    closes. Rejected or expired -> it says so in the conversation and asks
    what to change; the request stays open.

    **Rule: the Fleet Engineer always tells you what to do.** It never just
    explains why it can't do something. If it can't finish on its own, its
    reply is the steps that would unblock it (buy this, create that key, tell
    me which file is current) and what it will do once they're done. Secrets
    (API keys, passwords) never go in the conversation - they go in settings.
  - **Send to your AI IDE** - one button named and branded for the IDE you
    use ("Send to Claude Code" with Claude's logo, Cursor's for Cursor...).
    Which IDE is a setting in the config menu (for now `YOUR_IDE` in
    `Requests.tsx`). *Not built yet*. Finds the IDE you use, opens it and places a prompt in it.
    Needs a proper connector, and the IDE needs this system's MCP so it can read
    requests and create tools directly. The point is off-platform work the
    agency can't do itself (e.g. changing settings on your computer).
  - **DIY** - you did it yourself; write what you did / how it fixed it.
  - **Reject** - write why (optional).

## Status

UI only. The Fleet Engineer's response is simulated, the IDE buttons are
placeholders, and nothing reaches an agent yet.
