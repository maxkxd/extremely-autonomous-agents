# Agent DMs

One channel per agent (sidebar: Agent DMs). Modelled on the WAR agency's
per-agent Slack channels.

## What's in a channel

- **One post per run**, at the end of the run: a status line (outcome, run id,
  what triggered it, number of actions, cost, duration), the run's **final
  result text**, and one line per tool call (tool, action, and the argument
  *names* - never their values, so nothing sensitive lands in the channel).
- **Your messages**, and the agent's **reply** to them (a run triggered by
  your message, posted the same way).

It's two things at once: technical logs for debugging, and a place to message
an agent directly and get an answer back in the same channel.

## The rule: nobody is expected to read it

**An agent must never expect a person to check its DM channel.** If anything
it builds or does relies on someone reading the channel, it's built wrong.

- Anything that needs a human goes through **Approvals** (a human-approved
  tool call) or **Requests** (a resource request) - never "I've posted it in my
  channel".
- A person only looks at a DM channel when something is badly wrong, or when
  they asked a question **in that channel** and are waiting for the reply,
  which lands there.
- So the UI never pulls people into DMs: no unread badges, no notifications,
  the list is visually quiet.

This belongs in every agent's run instructions.

## Status

UI only. The run posts are placeholder history and replies to your messages
are simulated.
