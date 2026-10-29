# Architecture (direction)

The shape the product is heading for. Most of it isn't built yet.

## Two servers

1. **The organization's host** - run by each organization. It hosts that
   organization's agency: the agents run here, against the AI plans and API
   keys the organization connects itself. Today this is `apps/server`, running
   beside the desktop app.
2. **Our backend** - hosted by us (Railway). Accounts and sign-up, auth,
   organizations and their members, and anything that needs a secret we can't
   ship to everyone's machine (e.g. renewing GitHub tokens with the OAuth
   App's client secret).

The desktop and mobile apps talk to both: the host for the agency itself, our
backend for who you are and which organization you're in.

## What lives where

| Organization's host | Our backend |
|---|---|
| Agents, their Charters, TOOLS.yaml, KPI.yaml | Accounts, sign-up, sign-in, passwords |
| Model connections (keys, plan sign-ins), encrypted at rest | Organizations and members |
| Pack customization, the agent builder's calls | Secrets that must stay with us (OAuth client secrets) |
| | Later: billing |

Personal AI plans (Claude Code, Sign in with ChatGPT) belong on the host the
person controls: both providers are stricter about plans used from a hosted
service than from the user's own machine (docs/model-connections.md).

## Accounts and organisations (decided 2026-10-30)

- Everyone who signs up has one **personal agency**, for good, hosted on their
  own machine. They can **own (host) at most one organisation**, created in
  Settings, and **join any number**.
- The owner's machine is the org's host: every member's agents run there,
  members make agents, decide approvals and so on through it. When it's down,
  members see the org greyed out but readable, from their app's last snapshot
  ("Host offline since ..."); approvals keep counting on the host's clock.
- **The host is the only authority** over its agency: agents, keys, runs,
  approvals, roles (owner, admin, member). Every request to it carries an
  **org access token** (this person, this org, this role), short-lived and
  signed. The host checks only that one token format.
- **Who issues it is configuration, not a fork.** The official build (the
  extremely.agency download) trusts our backend: sign-in through **Clerk**,
  the directory (orgs, members, roles, invites, hosts) in our Postgres on
  Railway. A self-hosted host can issue tokens itself from local accounts, or
  trust its organisation's own sign-in, and never talk to us.
- **Members reach a host through our relay**: the host keeps one outbound
  connection to it; each host has a key pair whose public key our directory
  publishes; the app and the host set up an **end-to-end encrypted** session
  through the relay and the org token is presented inside it. The relay
  forwards bytes it can't read. Self-hosted: a direct https address instead.
- Our backend never stores agents, runs, keys or anything an agent touches.
- **Hosted service** (later): we run the same host in a container, registered
  as that org's host. Nothing changes for members.
- In an organisation the host's AI connections run every member's agents.
  Which plans and keys an organisation connects is its own business: no
  warnings or steering in the app (team and enterprise plans, a one-person
  organisation and so on are all legitimate; staying within a provider's
  terms is the organisation's responsibility).

Build order: (1) our backend - Clerk, Postgres directory, the rules, org
tokens, host registration; (2) the host checks tokens and roles and records
who did what; (3) sign-in, the personal agency, the org switcher, creating,
inviting, joining in the app; (4) the end-to-end encrypted relay; (5) offline
snapshots and the greyed-out state; (6) self-host mode.

## How it makes money

Open-source and free to self-host, with paid plans on top - the Snipe-IT
model:

- **Cloud hosting** of an organization's agency, instead of running the host
  themselves.
- **Our own AI usage**, instead of connecting their own keys (sold through our
  API accounts; never by reselling anyone's personal plan).

Both change what's allowed: a hosted host using someone's ChatGPT plan needs
OpenAI's approval, and Claude Code in a hosted service falls under Anthropic's
Commercial Terms and their conditions (docs/model-connections.md).
