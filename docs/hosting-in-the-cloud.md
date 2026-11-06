# Hosting an organisation in the cloud

An organisation's agency normally runs on its owner's computer, beside their
own agency (docs/architecture.md, "Accounts and organisations"). It can run in
a container instead, so it keeps working while that computer is off. The
container is the same server, registered as the organisation's host, with the
same host key: members' apps reach it through the relay exactly as before and
notice nothing.

## What runs in the container

`deploy/cloud/Dockerfile`, built from the repository root:

- the agency server (`apps/server`) as the organisation's agency
  (`EAA_HOSTED_ORG`), listening only inside the container;
- its own relay connection (`src/cloud.ts`, on with `EAA_CLOUD_HOST=1`): on a
  computer the person's own agency keeps it, here nothing else would;
- Google Chrome for the agents' browser, on a virtual display (Xvfb), with
  `EAA_BROWSER_ARGS="--no-sandbox --password-store=basic --disable-dev-shm-usage"`;
- Claude Code, for agents on a Claude plan.

Nothing listens outside the container. Its volume, mounted at `/data`, holds:

| Path | What |
|---|---|
| `/data/agency` | the agency's folder (`EAA_DATA_DIR`) |
| `/data/incoming` | a bundle moving an organisation in |
| `/data/sidecars` | extra programs (`*.mjs`) run beside the agency with `EAA_URL` set to it, started again a minute after they stop |

`scripts/cloud-host.ts` runs it all: it opens a bundle into an empty agency
folder, or over one that isn't the organisation's host yet (no host secret in its vault; never over a real one), starts the agency, then the sidecars. With no
agency and no bundle it waits for one to arrive in `/data/incoming`
(`EAA_START_EMPTY=1` starts an empty agency instead).

### Variables

| Variable | |
|---|---|
| `EAA_HOSTED_ORG` | the organisation's id |
| `EAA_ORG_NAME` | its name, for the logs |
| `EAA_TOKEN_ISSUER` | our backend's https address (the relay and org tokens) |
| `EAA_VAULT_KEY` | the container's vault key: 32 bytes, base64 |
| `EAA_HOST_PERSON` | the owner's name, as on their computer |
| `EAA_MOVE_IN_URL` | optional: where to fetch the bundle, instead of putting it in `/data/incoming` |
| `EAA_GOOGLE_CLIENT_ID`, `EAA_GOOGLE_CLIENT_SECRET` | the build's Google client, so Google sign-ins made with it keep renewing |

Sidecars get the container's variables too, except `EAA_VAULT_KEY`.

## Moving an organisation in

On the computer that hosts it, from `apps/server`:

```
node --import tsx scripts/move-org.ts --new-key
node --import tsx scripts/move-org.ts --to-key <that key> --out org.eaa --stop
```

The first prints a new vault key for the container (keep it as its
`EAA_VAULT_KEY`). The second stops the organisation's agency on this computer
(`--stop`: this computer no longer hosts it, and the app reaches it through the
relay from then on) and writes one file, encrypted with the container's key:

- the organisation's folder as it is: agents, runs, messages, memories,
  connections;
- its vault, opened here and sealed again with the container's key;
- the host's key pair and secret, from the person's own vault, so the
  container is the same host to the relay and the directory;
- every cookie in each of the agents' browser profiles, read through the
  browser's own DevTools connection. A profile's cookie file is locked to this
  computer's account (DPAPI on Windows), so copying the profile doesn't work;
  the profiles start empty in the container and their cookies are added the
  first time each opens (`browser:<n>:carried-cookies`).

`--sidecar file.mjs` adds a sidecar to the bundle. Then put the bundle in the
container's `/data/incoming` (or give its address as `EAA_MOVE_IN_URL`) and
start the container.

Some sites tie a sign-in to the device it was made on (Google can, in Chrome
on Windows): those are made again in the container.

## AI in the container

Nobody can sign in to Claude Code in a container. Connect the Claude plan with
a long-lived token instead: run `claude setup-token` on your own computer and
give the token it prints to the organisation's Claude connection
(`POST /api/connections/claude-code/token`, `{ "token": "sk-ant-oat01-..." }`;
an empty token forgets it). It's kept in the vault and given to Claude Code as
`CLAUDE_CODE_OAUTH_TOKEN`. An Anthropic API key works as on any computer.

## Not yet

- Sign-ins that come back to the app's port (OAuth integrations started from a
  member's app) can't reach a container; connections moved in keep working.
- A person can't see the container's screen: the agents' browser's live view
  in the app (a stream of its tabs through the relay) is next. Until then,
  CAPTCHAs and phone codes there wait.
