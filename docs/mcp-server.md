# The public MCP server (design, not built)

A small package anyone can install in Claude Desktop, Cursor, VS Code, Claude
Code, Windsurf and so on, so they can talk to their agency there: "what did my
sales agent do today?", approvals, Requests, giving an agent a job, its latest
report, starting a run. It is the kind of server MCP registries list.

## What's already there

Most of it exists. The missing part is a package people can install without
copying an address out of Settings.

- **The agency's MCP server** (`runner/agency-mcp.ts`, docs/requests.md):
  24 tools covering requests, agents, the builder, integrations and approvals
  (read-only). It answers at `http://127.0.0.1:5175/mcp/<token>` (`runner/mcp.ts`),
  and the token picks who it acts as: the host computer's own person, or one
  address per org member (`mcp_people`). A member's membership and role are
  re-checked with our backend at most every 5 minutes.
- **A teammate's computer** (`runner/remote-mcp.ts`): an address on their own
  computer. Each message waits there until their app (open, signed in) sends it
  through the relay, end-to-end encrypted with their org token, to the host's
  `POST /api/agency-mcp/rpc`. The relay sees ciphertext only.
- **One-click connect** (`runner/assistant.ts`): for Claude Desktop it writes
  a tiny stdio-to-HTTP program into `claude_desktop_config.json`, run on the
  app's own Node, and Cursor gets its install link.

Why registries can't list this yet: there is no fixed install command. Every
address carries a secret token that only Settings can hand out, the stdio
program is generated on the person's computer, and nothing is published to
npm.

## Shape

**A local stdio package, `npx -y @extremely/agency-mcp`** (the name is an open
question). It does not change and needs no settings: it finds the running app
by itself and passes JSON-RPC to the addresses above. It holds no keys, no
sign-ins and no agency data. The agency stays on the host, as it does today.

```
AI app ──stdio──> agency-mcp ──http 127.0.0.1──> the app on this computer
                                                    │ own agency: answered here
                                                    │ org hosted here: /hosted/...
                                                    └ org hosted elsewhere: relay,
                                                      E2E, org token, to its host
```

### How it finds the app

1. **A discovery file the app writes** on every start:
   `%APPDATA%\Extremely Autonomous Agents\mcp.json` (Electron's userData; on
   macOS and Linux, the matching userData folder). It holds
   `{ v: 1, agencies: [{ id, name, role, url }] }`: your own agency's standing
   address, and for each organisation you're in, the address that acts as you
   (a `remoteMcpUrl` one for an org hosted elsewhere). It's rewritten when you
   join or leave an org, regenerate an address or sign out, so sign-out drops
   the org entries.
2. **`EXTREMELY_MCP_URL`**, an override for a self-hosted org or testing. It
   takes one address and skips the file.
3. **Nothing found or not answering**: `initialize` and `tools/list` still
   work from a tool list bundled in the package, so registry checks
   (Smithery and Glama inspect `tools/list`) and the AI app's tool picker see
   the real tools. Every `tools/call` then says: "Open the Extremely
   Autonomous Agents app on this computer, then try again." The package never
   starts the app itself.

The file has the same trust as today: it is in the person's own profile
folder, where `claude_desktop_config.json` already holds the same address.
Any program running as that person can read it, which was already true.

### Which agency

Every tool gets an optional `agency` argument (an id or a name from
`list_agencies`). Left out, it means your own agency, or the only org if you
have no agency of your own. Each call goes to that agency's address, and the
host decides what your role allows (`runAs` already refuses admin tools to
members). A per-argument choice works in every AI app. Switching with
`tools/list_changed` doesn't: support for it varies from app to app.

## Auth: owner vs member

| Who | Path | Acts as | Checked by |
|---|---|---|---|
| Owner, own agency | standing address (`agency_mcp_token`) | `localActor()`, the owner | the host itself, no account needed |
| Owner of an org hosted on this computer | through own agency to `/hosted/...` | owner | the host process |
| Member at the host computer | their `mcp_people` address | them, their role | host, plus backend re-check every 5 min |
| Member on their own computer | `remoteMcpUrl`, then app, then relay (E2E), then host | them, via their org token | host, every request |
| Self-hosted org | `EXTREMELY_MCP_URL`, its own address | its accounts | the self-host, every request |

The package itself never signs anyone in. A member's org token stays in their
app, which must be open and signed in, as it already must be for
`remote-mcp.ts`. Our backend sees only who is in which organisation and relay
ciphertext, so the promise is kept: our servers never see agency data, keys
or sign-ins in plaintext.

## Tools

Tiers read the way Settings names them. For a person's own MCP calls the tier
means:

- **Silent**: read-only (`readOnlyHint: true`), nothing recorded.
- **Logged**: recorded in `person_actions`, with a notice in the agent's DM
  channel where it's about an agent.
- **Approval**: a person confirms it in person. The AI app's own
  "allow this tool call?" prompt isn't enough: auto-approve settings and YOLO
  modes skip it. So the host asks through MCP **elicitation**, which goes to
  the human and not to the model. Where the app doesn't support elicitation,
  the call is refused and the answer points to the app. (See open question 1.)

Every tool also gets `title`, `readOnlyHint`, `destructiveHint` and
`idempotentHint` annotations, which Anthropic's directory requires and other
apps use to decide what to auto-allow. Today `runner/mcp.ts` sends none.

### The "talk to your agency" set (new or changed)

| Tool | Tier | What it does | Status |
|---|---|---|---|
| `list_agencies` | Silent | Your own agency and each org: name, role, online or "host offline since ..." | new, answered by the package |
| `agency_today` | Silent | Per agent since a time (default: today, host clock): runs, output actions (KPI), what's waiting on you, requests filed | new: `runs`, `actions`, `approvals`, `requests` |
| `agent_activity` | Silent | One agent: its DM channel posts and runs since a time ("what did my sales agent do today?") | new: `dm`, `runs` |
| `latest_report` | Silent | Its last report: summary, and where it went (file or link, per `reports.ts` destinations) | new |
| `list_agents`, `read_agent` | Silent | as today | exists |
| `list_approvals` | Silent | Pending, only the ones that are yours to decide | exists |
| `decide_approval` | **Approval** | Approve or reject one, with a note. Shows exactly what will run, confirmed by elicitation | new: wraps `decideApproval`, same `requireMakerOrAdmin` check as `POST /api/runner/approvals/decide` |
| `list_requests` | Silent | as today | exists |
| `reply_to_request` | Logged | Write in a request's thread with the Agency Engineer (it wakes) | new: wraps the thread reply in `engineer.ts` |
| `answer_request` | Logged | Close as done or rejected | exists |
| `give_task` | Logged | Give an agent a job (`tasks`, `from_agent` null = a person), and it runs | new |
| `run_agent` | Logged | Run now, or message it | exists |
| `set_agent` | Logged | Ferocity, pause, stop or resume | exists |

### The builder set (exists, unchanged)

`write_agent_file`, `list_models`, `set_agent_models`, `builder_guide`,
`check_build`, `create_agent` and the integration tools are **Logged**.
`delete_agent` and `discard_integration` with `remove_live` are
**Approval**: they're hard to undo, so they get elicitation as well.
Integration-building stays owner and admin only, as now.

That makes about 30 tools, under the point (around 40) where Cursor starts
warning.

## Protocol hygiene the package needs

- Negotiate `protocolVersion` against a list we support. Today any version
  the client sends is echoed back.
- Stdio rules: protocol only on stdout, logs to stderr, handle
  `notifications/initialized`, and stay alive across app restarts by
  re-reading the discovery file on each failure.
- No dependencies, Node 18+ (`fetch`), like today's bridge. The one-click
  connect keeps running the same file on the app's own Node, so people who
  don't have Node installed are unaffected. The npm package is the same file,
  published.

## Packaging and registries

- **npm**: `@extremely/agency-mcp`, built from `packages/agency-mcp/` in this
  repo (AGPL-3.0), with `mcpName` in `package.json` for the official
  registry. Published by the manual, approval-gated Release workflow like
  the app.
- **`server.json`** for the official MCP Registry
  (`registry.modelcontextprotocol.io`). Namespace `agency.extremely/agency`
  needs a DNS TXT record on extremely.agency; the fallback is
  `io.github.<org>/agency-mcp` with GitHub sign-in. VS Code's MCP gallery
  and GitHub's MCP registry read from it.
- **Submission list**:
  1. Official MCP Registry (`mcp-publisher publish`)
  2. Smithery (`smithery.yaml`, stdio `startCommand`, local server)
  3. mcp.so (submit form / GitHub issue)
  4. Glama (picked up from GitHub, claim it, keep the inspection passing)
  5. PulseMCP (submit, also fed by the official registry)
  6. Cursor's MCP directory (cursor.directory) and an "Add to Cursor" deep link
  7. awesome-mcp-servers (PR)
  8. Claude: local servers go in the **Desktop Extensions** directory as an
     `.mcpb` bundle (the package plus `manifest.json`). The Windows Store
     Claude Desktop doesn't open `.mcpb` files (assistant.ts), so the
     one-click config write stays. Claude's **remote connector directory**
     needs a public HTTPS endpoint with OAuth, so it belongs to the hosted phase.
  - Not a fit: Docker MCP Catalog and other hosted runners. A container
    can't reach the app on someone's computer.

## Later: remote HTTPS endpoint (hosted plan only)

ChatGPT, claude.ai and Claude's connector directory need a public
Streamable HTTP endpoint with OAuth 2.1 (MCP authorization spec). That fits
**only the hosted plan**, where we already run the org's host in a container:
`https://<org>.extremely.agency/mcp` (or one address with the org chosen at
sign-in), Clerk as the authorization server, and the tokens mapping onto the
same org access token and roles.

For an org hosted on someone's own computer it's ruled out: a public endpoint
would have to end TLS on our servers and see plaintext, which breaks the
end-to-end promise. Those people use the local package.

## Effort (one developer, with tests)

| Piece | Days |
|---|---|
| Package: stdio, discovery file, `agency` routing, bundled tool list, offline answers | 2 |
| App writes and refreshes the discovery file | 0.5 |
| New tools (`agency_today`, `agent_activity`, `latest_report`, `decide_approval`, `reply_to_request`, `give_task`, `list_agencies`) and annotations | 2.5 |
| Elicitation for Approval-tier calls, version negotiation | 1 |
| Tests: unit, plus live in Claude Desktop, Cursor, VS Code and Claude Code as owner and as a member through the relay | 1.5 |
| npm, `server.json`, `smithery.yaml`, `.mcpb`, README, release workflow | 1 |
| Submissions | 0.5 (plus each registry's review wait) |
| **Total** | **about 9 days** |

The hosted HTTPS endpoint is separate: about 2 to 3 weeks (OAuth, per-org
routing, rate limits, connector-directory review).

## Open questions (for the owner)

1. **May an AI app decide approvals at all?** Approvals are the human gate on
   agents' outside-world actions. Proposal: yes, but only through elicitation
   (the person confirms in the AI app's own dialog, and the model can't
   answer it), refused where an app doesn't support elicitation. The
   alternatives are read-only (today's behaviour) or a Settings switch.
2. **Package and registry names**: `@extremely/agency-mcp` (is the npm scope
   free or held?), and the registry namespace `agency.extremely/*`, which
   needs a DNS TXT record on extremely.agency that only the owner can add.
3. **Builder tools in the public package**, or a smaller "talk to your
   agency" set by default with the builder set behind a flag?
4. **Settings UI**: should Connectors show the `npx` command and the
   registries' install buttons? That's a UI change, so it's not in the
   estimate until approved.
5. **Members need their app open** for an org hosted elsewhere (the relay
   session lives in the app). Is that acceptable for v1? The alternative is
   a relay client inside the package, which would mean the package holding
   the org token: more work, and a second place that holds a sign-in.
6. **macOS and Linux**: the package runs anywhere, but the app is
   Windows-first. Should the registry listings say Windows only for now?
