# Events

An agent runs on its schedule, and can also be woken by **events**: something
happening at a service it watches - a new Sentry issue, a support ticket, a
CloudWatch alarm, a failed payment. There's no difference in kind between a
scheduled agent and an event-driven one: every agent can have both, and
events are added to agents the way tools are.

Ferocity still applies to a run an event starts: its floor, its nudges, the
runs it books itself. A reactive agent is usually left on Chill or Steady, its
schedule a slow sweep for anything missed; on Apocalyptic it keeps going after
the event like any other run.

## Defining them (`integrations/schema.ts`)

An event belongs to an integration, so the person's key or sign-in for the
service covers it. In the integration's definition, under `events:`:

```yaml
events:
  - id: sentry.new_issue
    description: A new Sentry issue
    # Polling: the service's API, checked for new items.
    poll:
      base_url: https://sentry.io/api/0     # default: the integration's
      request: { path: /projects/acme/web/issues/, query: { query: "is:unresolved", sort: date } }
      items: ""                             # dot path to the list; empty: the answer is the list
      id: id                                # each item's unique id
      fields: { title: title, level: level, url: permalink }   # what the agent sees
      every_minutes: 5
    # Webhooks: the service posts to the agency's address.
    webhook:
      items: ""                             # when one post carries several
      id: data.issue.id
      fields: { title: data.issue.title, url: data.issue.web_url }
      signature: { header: Sentry-Hook-Signature, algorithm: sha256, encoding: hex }
      secret_help: The integration's Client Secret, in Sentry -> Settings -> Developer Settings
    setup_help: Sentry -> Settings -> Developer Settings -> your integration -> Webhook URL
```

Either or both. Webhooks are instant; polling works with nothing exposed and
catches anything a webhook missed.

## How they run (`runner/events.ts`)

- **Each item is told once** (`event_items`). The first poll only notes what's
  already there, so subscribing never wakes an agent for a backlog.
- **Who's woken**: every agent whose `TOOLS.yaml` lists the event under
  `events:`. A wake that hasn't run yet (the agent busy, stopped, on standby)
  takes later items too, so a burst is one run.
- **The run** has trigger `event`; its opening is the event and its items (up
  to 10 written out, the rest counted).
- **Standby and Stop**: an event wake waits, like a schedule. While the
  agency is stopped nothing is polled (the next poll catches up); a webhook
  post is still taken, and its run waits.
- **A draft's webhook**: posts are kept but wake nobody, so the Fleet Engineer
  can see what the service sends (`engineer.test_event`).

## Webhooks and the tunnel (`runner/hooks.ts`)

Webhooks go to a server of their own on port 5176 that takes `POST
/hooks/<token>` and nothing else: never the app's API. Each event has its own
random address; signed posts are checked (HMAC of the raw body) against the
signing secret the person saves in Settings -> Connectors.

The app runs on the person's computer, which services can't reach. **Public
webhook address** in Settings -> Connectors starts a Cloudflare quick tunnel
(`cloudflared`, no account) to that webhook server only, and shows its https
address. It changes each time the tunnel starts, so the addresses to paste
into services are always the ones Settings shows. Without it, the addresses
are this computer's, for tools on it and for testing. Once the hosted backend
exists it can relay webhooks instead.

## Who adds them

- **The agent builder**: gives an agent existing events by id, and defines
  `new_events` for ones nothing provides yet. Each missing one becomes a
  request to the Fleet Engineer ("Set up the event sentry.new_issue"), once -
  a pack agent asks again after its tailoring if that added any.
- **The Fleet Engineer**: writes the event into the service's integration,
  tries it (`engineer.test_event`: a real poll, and the webhook address), asks
  the person for the key, webhook setup and signing secret, and on go-live the
  agent that asked is subscribed. `engineer.give_events` subscribes an agent
  to events that are already live (a person approves).
- **The person's IDE** (the agency's MCP server): `test_event`,
  `give_events`, and `publish_integration` with `events`.

## Tested

Unit tests (`events.test.ts`): items and ids, the first-poll baseline, one
wake per new item and none for repeats, bursts joining a waiting wake, a
failing poll noted, nothing polled while stopped, signatures, standby, and the
builder's events.

Live (2026-10-29): a test integration with a polling event on GitHub's API
and two webhook events, written, tested and published through the agency's
MCP server. A real poll found GitHub's latest issues; a webhook woke a test
agent (on Claude Code), which named the alarm, with its DM post marked
`event`. A repeat post was ignored. A redraft kept the live events working.
A signed event refused posts with no secret saved, a bad signature or none,
and took a good one. The webhook port answers 404 to the app's API.

The tunnel, once cloudflared was installed (winget, 2026.10.5): a public
trycloudflare.com address in about 10 seconds; a webhook posted to it from
outside went through Cloudflare and was taken; the app's API, the IDE's MCP
server and its root all answer 404 through it. cloudflared is found on the
PATH or in its installer's folder, so a server started before installing it
still finds it.
