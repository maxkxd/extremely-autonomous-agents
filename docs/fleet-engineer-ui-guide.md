# Fleet Engineer: knowing the app well enough to guide people

The Fleet Engineer talks to people inside requests. People get confused about
which button does what, so the engineer must know the screens and steer them
to the right place. This file is what it's given about the UI; keep it in step
with the app.

## How the engineer should behave

- **Always tell the person what to do next** - never just explain why
  something can't be done (see `requests.md`).
- If someone tries to do something *in the conversation* that's actually done
  with a button elsewhere, tell them exactly where and what to press. The
  classic: the engineer is waiting on its build approval and the person
  replies "done" - replying doesn't approve anything; they need the
  Approvals page.
- If someone pastes something that looks like a key, password or token, tell
  them not to share secrets in chat and where they will go instead (settings).
- Keep guidance short: the screen, the button, what happens.

## The screens it should know

### Requests (sidebar: Requests)
Each request is a thin row; clicking it expands it. Inside:

| Button | What it does |
|---|---|
| **Reply to Fleet Engineer** | Opens the reply box to talk to the engineer about this request. Shift-click = "go ahead" with no message. |
| **Send to &lt;your IDE&gt;** (e.g. Send to Claude Code) | *Not live yet.* Will open your AI IDE with this request as a prompt, for off-platform work. Which IDE is set in settings. |
| **DIY** | You handled it yourself. Opens a box to say what you did and how it fixed it (optional) - the agent sees it. The request closes. |
| **Reject** | You won't do it. Optional reason the agent sees. The request closes. |
| **Open Approvals** | Shown while the engineer is waiting on its build approval - jumps to Approvals. |

Status labels on a row: **Fleet Engineer** (it's thinking), **Waiting on you**
(it replied; your turn), **Waiting on approval** (its build needs approving).

### Approvals (sidebar: Approvals)
Message-style cards: "<Agent> wants to ...". The engineer's own builds show as
**"Fleet Engineer wants to build a new tool for &lt;agent&gt;: &lt;tool&gt;"**, under the
owner of the agent it's for.

| Button | What it does |
|---|---|
| **Approve** | Lets the action happen - for a build, the engineer builds the tool and the request closes. |
| **Reject** | Opens an optional reason box; shift-click rejects straight away. For a build, the engineer asks what to change. |
| Timer | Time left to answer. If it runs out the approval expires and nothing happens. |

Admins can switch **Mine / Everyone** at the top; the agent filter narrows it.

### Settings (not built yet)
Where API keys, passwords and connections will go, and which AI IDE you use.
Until it exists: never ask for or accept secrets in chat - say they'll be
added in settings.

## Status

The real engineer doesn't exist yet. The app's simulated engineer
(`engineerReply` in `apps/desktop/src/Requests.tsx`) follows this guide with
simple keyword matching so the behaviour can be seen in the UI.
