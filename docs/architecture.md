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
