# Hosting an organisation in the cloud

An organisation's agency normally runs on its owner's computer, beside their
own agency (docs/architecture.md, "Accounts and organisations"). It can run in
a container instead, so it keeps working while that computer is off. The
container is the same server, registered as the organisation's host, with the
same host key: members' apps reach it through the relay exactly as before and
notice nothing.

Everything here is part of the open-source product: anyone can build the image
and run their organisation's agency on their own server or cloud account. Our
hosted plan is this same container, run by us. What's ours alone is how we
run it (accounts, keys, monitoring), which isn't in this repository.

To run many organisations on one server you rent, each in its own container
with its own memory cap and https address, see
[deploy/vps/README.md](../deploy/vps/README.md).

## What runs in the container

`deploy/cloud/Dockerfile`, built from the repository root:

- the agency server (`apps/server`) as the organisation's agency
  (`EAA_HOSTED_ORG`), listening only inside the container;
- its own relay connection (`src/cloud.ts`, on with `EAA_CLOUD_HOST=1`): on a
  computer the person's own agency keeps it, here nothing else would;
- no browser: agents browse in the members' own Chrome or Edge, through the
  EXTREMELY extension (docs/browser-extension.md, "Pairing" says which address
  it connects to), which reaches the agency at the container's public address
  through the link front (`src/link-forward.ts`);
- Claude Code, for agents on a Claude plan.

Only the browser link listens outside the container (below). Its volume, mounted at `/data`, holds:

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
| `EAA_TOKEN_ISSUER` | our backend's https address (the relay and org tokens; the app's anonymous reports of its own gaps and connection failures go there too, or to `EAA_REPORT_URL`) |
| `EAA_VAULT_KEY` | the container's vault key: 32 bytes, base64 |
| `EAA_HOST_PERSON` | the owner's name, as on their computer |
| `EAA_MOVE_IN_URL` | optional: where to fetch the bundle, instead of putting it in `/data/incoming` |
| `EAA_MOVE_IN_REPLACE` | `1`: that bundle replaces the agency here even when it's already the host (moving in again from a better copy), once per address; the old agency is kept as `agency.replaced-<when>` |
| `EAA_GOOGLE_CLIENT_ID`, `EAA_GOOGLE_CLIENT_SECRET` | the build's Google client, so Google sign-ins made with it keep renewing |
| `EAA_PUBLIC_URL` | the container's public https address, for the browser link (below); on Railway, `RAILWAY_PUBLIC_DOMAIN` does when this isn't set |
| `EAA_AGENCY_PORT` | optional: the port the agency listens on inside the container (5195) |

Sidecars get the container's variables too, except `EAA_VAULT_KEY`.

The platform sets `PORT` (often 8080), the port its public address goes to. Only the browser link front listens there (`src/link-forward.ts`): it passes WebSocket upgrades on `/api/browser-link` to the agency and answers anything else with a 404. The agency itself listens inside the container only, on `EAA_AGENCY_PORT` (5195 by default), and sidecars get that address. A sign-in the person's browser completes — a service, ChatGPT, OpenRouter — comes back to the app on their computer, port 5175 (`EAA_CALLBACK_PORT` when that app is not the usual one). Their app sends the result to this host. Nothing on their computer is listening on the container's port.

### The browser link needs the public address

Members pair their own Chrome or Edge with the hosted agency (Connectors >
Browser), and the extension connects to it from their computer over `wss`. The
pairing tells it where: `wss://<public host>/api/browser-link`, the host from
`EAA_PUBLIC_URL`, or on Railway from `RAILWAY_PUBLIC_DOMAIN` (Railway sets it
once the service has a public domain) when `EAA_PUBLIC_URL` isn't set.

So give the service a public domain aimed at `PORT` (Railway: Settings >
Networking > Generate Domain), or set `EAA_PUBLIC_URL` to the address in front of
it. With neither, the pairing falls back to the address the app reached the
agency at, which for a cloud host isn't one a browser can reach.

The link authenticates itself (a one-time pairing code, then the browser's
token). The front adds nothing to that and opens nothing else.

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
- not the browser's sign-ins: agents work in the person's own browser, which
  stays where it is. Pair it with the hosted agency (Connectors > Browser) and
  the sign-ins are there.

`--sidecar file.mjs` adds a sidecar to the bundle. Then put the bundle in the
container's `/data/incoming` (or give its address as `EAA_MOVE_IN_URL`) and
start the container.

## AI in the container

Nobody can sign in to Claude Code in a container. Connect the Claude plan with
a long-lived token instead: run `claude setup-token` on your own computer and
give the token it prints to the organisation's Claude connection
(`POST /api/connections/claude-code/token`, `{ "token": "sk-ant-oat01-..." }`;
an empty token forgets it). It's kept in the vault and given to Claude Code as
`CLAUDE_CODE_OAUTH_TOKEN`. An Anthropic API key works as on any computer.
