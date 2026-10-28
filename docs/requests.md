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
  - **Task Fleet Engineer** - hand it back with a human's push. If it still
    can't be done, the engineer adds an addendum to the request saying why.
  - **Send to your AI IDE** (Claude Code, Cursor, Antigravity, Codex...) -
    *not built yet*. Finds the IDE you use, opens it and places a prompt in it.
    Needs a proper connector, and the IDE needs this system's MCP so it can read
    requests and create tools directly. The point is off-platform work the
    agency can't do itself (e.g. changing settings on your computer).
  - **DIY** - you did it yourself; write what you did / how it fixed it.
  - **Reject** - write why (optional).

## Status

UI only. The Fleet Engineer's response is simulated, the IDE buttons are
placeholders, and nothing reaches an agent yet.
