# The public MCP server

A small package anyone can install in Claude Desktop, Cursor, VS Code, Claude
Code, Windsurf and so on, so they can talk to their agency there: "what did my
sales agent do today?", approvals, Requests, giving an agent a job, its latest
report, starting a run. It is the kind of server MCP registries list.

Built 2026-11-05 (`packages/agency-mcp`, see Status at the end). Published
2026-11-06 as `@extremely-agency/mcp` on npm and `agency.extremely/agency` in
the official MCP registry.

## One address for every agency (owner, 2026-11-16)

What the owner asked for: connect your AI assistant from the app in one
click, and have it reach every agency you're in, as you, from any computer
with the app (not only the one hosting the organization). When it isn't
obvious which agency something is for, the AI asks the person.

- **The address** (`runner/mcp-router.ts`): one MCP address on this
  computer's app, `http://127.0.0.1:<port>/mcp/<token>`, its token kept
  across restarts (`mcp_router_token`). Behind it, the same agencies as the
  directory file: your own agency here, and each organization you're in
  through `remote-mcp.ts` (the app carries it to the host, end to end
  encrypted, acting as you with your role). Every tool takes `agency`, plus
  `list_agencies`.
- **Which agency**: named, that one (id, name or part of a name). Not named:
  the only agency, or the only organization beside an own agency with no
  agents of its own (built-in ones don't count). Otherwise the call is
  refused with "Ask the person which agency this is for", listing them, and
  nothing is sent. The server's `instructions` say the same, and to read
  `builder_guide` before making an agent.
- **Settings > Connectors > MCP (connect your AI assistant)**: Connect
  Claude Desktop, Claude Code, Cursor, VS Code, and the address in a box
  with Copy. All of them get this one address, always from this computer's
  own app (`GET /api/assistant/mcp`, `POST /api/settings/assistant/connect`,
  local only), whichever organization is open.
  - Claude Desktop: the bridge in its settings, as before. Open, it would
    write over the change, so the app says so and offers **Restart Claude
    Desktop**, which quits it (only Claude Desktop, told apart from Claude
    Code by its path), writes, and opens it. Earlier one-per-organization
    entries (`extremely-autonomous-agents*`) are replaced by one,
    `extremely`.
  - Claude Code: `claude mcp add --transport http --scope user extremely
    <address>`, found on PATH or in `~/.local/bin`. It shows in sessions
    started after. Not installed: the error gives the command.
  - Cursor and VS Code: their install links (`cursor://...`,
    `vscode:mcp/install?...`), which ask the person to click Install.
- **The package** passes everything to this address when the directory file
  gives one (`router`), so it asks the same way. Older apps don't write it,
  and the package keeps its own routing for them. Needs a new package
  release (0.2.0) to reach people.

## What was already there

Most of it existed. The missing part is a package people can install without
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

**A local stdio package, `npx -y @extremely-agency/mcp`** (the name is an open
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
   `%APPDATA%\Extremely Autonomous Agents\agency-mcp.json` (Electron's
   userData; on macOS `~/Library/Application Support/...`, on Linux
   `~/.config/...`; `EAA_MCP_DISCOVERY` moves it), written by
   `runner/mcp-directory.ts`. It holds
   `{ v: 1, agencies: [{ id, name, role, url }] }`: your own agency's standing
   address, and for each organisation you're in, the address that acts as you
   (a `remoteMcpUrl` one, carried by the app, for every organisation, the
   one hosted on this computer too). The server doesn't know your
   organisations, so the desktop app tells it (`POST /api/assistant/directory`,
   this computer only) when they change. Sign-out sends none, so it drops the
   org entries. It's also rewritten when the standing address is replaced.
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
| Owner of an org hosted on this computer | `remoteMcpUrl`, then the app, then `/hosted/...` | owner | the host process |
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
- **Logged**: recorded in `person_actions` (who did what), as the app's own
  changes are: route `MCP <tool>`.

There's no Approval tier for these calls (decided 2026-11-05). The person
controls which tools their AI app may call, and whether it asks first, in
that app's own settings, so the host adds no extra confirmation step. That
includes deciding approvals. Hard-to-undo tools are marked
`destructiveHint: true`, so AI apps ask before them by default.

Every tool also gets `title`, `readOnlyHint`, `destructiveHint` and
`idempotentHint` annotations, which Anthropic's directory requires and other
apps use to decide what to auto-allow (`HINTS` in `runner/agency-mcp.ts`).

### The "talk to your agency" set (new or changed)

| Tool | Tier | What it does | Status |
|---|---|---|---|
| `list_agencies` | Silent | Your own agency and each org: name, your role, whether it answers right now | new, answered by the package |
| `agency_today` | Silent | Per agent since a time (default: today, host clock): runs, output actions (KPI), what's waiting on you, requests filed | new: `runs`, `actions`, `approvals`, `requests` |
| `agent_activity` | Silent | One agent: its DM channel posts (each run's write-up and tools used) and the jobs given to it, since a time ("what did my sales agent do today?") | new: `dm`, `tasks` |
| `latest_report` | Silent | Its last report: summary, and where it went (file or link, per `reports.ts` destinations) | new |
| `list_agents` | Silent | Each agent with its spend this month, its own limit, last run, whether it's running, approvals and open jobs. Filter by state or department | exists; cost added 2026-11-19 |
| `read_agent` | Silent | An overview by default (no file bodies: state, models, spend, file sizes, the Charter's headings, last runs with cost). Then one `section` (charter, tools, kpi, runs, memory), one Charter `heading`, or a character window (`offset`/`limit`) | exists; sections added 2026-11-19 |
| `list_approvals` | Silent | Pending, only the ones that are yours to decide, one line each (to, subject, why, sender, queue account), counts per account; `detail: true` for every argument; filters and `offset`/`limit` | exists; compact 2026-11-19 |
| `decide_approval` | Logged (destructive) | Approve or reject one, with a note. The person who decided is recorded as on the Approvals screen | new: wraps `decideApproval`, same `requireMakerOrAdmin` check as `POST /api/runner/approvals/decide` |
| `decide_approvals` | Logged (destructive) | Many at once, by ids or agent / tool / account. `every_minutes` sets a pace on each account first, so approving a pile of emails doesn't send them at once | new 2026-11-19 |
| `usage` | Silent | Cost between two times (default: this month), grouped by agent, day, model, connection or trigger, with each limit and what's left | new 2026-11-19 (see below) |
| `list_queue` | Silent | Approved, not run yet: when each runs and why; paces, holds after a failure, and how many ran per account lately | new 2026-11-19: `scheduledRows`, `action_pace` |
| `set_pace` | Logged | A person's pace for one agent's tool (per account), as the agent's own `approvals.pace_mine` | new 2026-11-19: `paceMine` |
| `schedule_queue` | Logged (destructive) | Run now, later, spread or cancel approved actions; lets go of a hold | new 2026-11-19: `scheduleMine`, labelled with the person's name |
| `list_requests` | Silent | as today | exists |
| `reply_to_request` | Logged | Write in a request's thread with the Agency Engineer (it wakes) | new: the app's own `personWrites` (api.ts) |
| `answer_request` | Logged | Close as done or rejected | exists |
| `give_task` | Logged | Give an agent a job (`tasks`, `from_agent` null = a person), and it runs | new |
| `run_agent` | Logged | Run now, or message it | exists |
| `set_agent` | Logged | An agent's goal, or its pause, stop or resume; when the whole agency holds it, says so | exists |
| `set_agency_state` | Logged | The whole agency's Resume / Standby / Stop, as on the dashboard; no state reads it. Admins only | new (2026-11-25) |

### The builder set

`write_agent_file`, `list_models`, `set_agent_models`, `builder_guide`,
`check_build`, `create_agent` and the integration tools are **Logged**.
`delete_agent` and `discard_integration` are Logged and marked destructive.
Integration-building stays owner and admin only, as now.

`edit_agent_file` (2026-11-19, Logged, destructive) changes part of a file:
exact `{old, new}` replacements that must each match once, or a Charter
`heading` with `mode` replace / append / insert_after / delete. It checks the
file the same way `write_agent_file` does (YAML parses, the agent still loads,
otherwise the old file goes back), and answers with a one-line diff.

That makes 36 tools, under the point (around 40) where Cursor starts warning.

### Size (2026-11-19)

No answer is longer than 20,000 characters (`MAX_RESULT_CHARS` in
`runner/agency-mcp-views.ts`). A longer one is cut and ends with the exact call
that gets the rest. `builder_guide` and `read_integration` are exempt, because
they're read whole. This was added after `read_agent` returned 80,000
characters for one agent and overflowed the AI app.

### Where cost comes from

| Question | Where |
|---|---|
| What one run cost | `runs.cost_usd`, `input_tokens`, `output_tokens`, `model`, `connection` |
| Price per model | `runner/pricing.ts`. A null `cost_usd` means no known price: missing, not zero (`unpriced_runs`) |
| Plan runs | Priced as the same model on its API, and counted toward the limits. Ollama is $0 |
| This month, per agent | `SUM(runs.cost_usd)` from `startOfMonth` (the host's clock), as `GET /api/usage` |
| Today | `spentToday()` |
| Limits | `agent_state.spend_cap_usd`, setting `spend_cap_org_usd` (monthly) |

### Accounts and pacing

A pace and the queue go per agent, tool and **account**, and the account is
what `accountOf()` finds in the action's top-level arguments. A sender nested
deeper, like Zoho's `body.fromAddress`, counts as the tool's one account, so
all of that tool's sends share one queue. That's right for a rate limit,
because those mailboxes are aliases of one sending account. `list_approvals`
and `list_queue` show both the queue account and the sender. Their `account`
filters accept either.

## Protocol

- `protocolVersion` is negotiated against the versions we answer as
  (`PROTOCOLS` in `runner/mcp.ts` and the package): the client's own when
  it's one of them, else the newest. It used to echo any version back.
- Stdio rules: protocol only on stdout, logs to stderr, handle
  `notifications/initialized`, and stay alive across app restarts by
  re-reading the discovery file on each failure.
- No dependencies, Node 18+ (`fetch`). The one-click connect is unchanged
  (its own small bridge, on the app's own Node), so people without Node
  installed are unaffected.

## Packaging and registries

- **npm**: `@extremely-agency/mcp`, built from `packages/agency-mcp/` in this
  repo (AGPL-3.0), with `mcpName` in `package.json` for the official
  registry. Published by hand with the approval-gated **Publish
  agency-mcp** workflow (`.github/workflows/agency-mcp.yml`): npm trusted
  publishing (no stored token), provenance, and the `.mcpb` as its artifact.
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

## Status (2026-11-05)

Built and tested:

- **The package** (`packages/agency-mcp`: `index.js` the program, `lib.js`
  what it does, `tools.json` the bundled list). 10 tests (`npm test` there):
  finding the file, picking an agency, the version, live and bundled tool
  lists, routing with `agency`, refusals, the app closed, a replaced address,
  and a real stdio run.
- **The host**: the six new tools, annotations on all 30, version
  negotiation, MCP calls recorded in `person_actions`, the directory file
  (`runner/mcp-directory.ts`). `agency-mcp-tools.test.ts` covers them, and
  fails if `tools.json` is out of date (`npm run agency-mcp-tools` in
  apps/server rewrites it). The whole server suite passes.
- **Live**: a real server on spare ports wrote the file on start. The package
  found it, listed 31 tools and answered `list_agencies`, `agency_today`,
  `list_approvals` and `list_agents` over stdio. An organisation the app had
  reported answered "open the app", as it should with no app window to
  carry it.
- **In real AI apps** (a throwaway agency with test data, never the real one):
  - **Claude Code**: answered "what did my sales agent do today and what's
    waiting on me"; rejected an approval with a note, replied on a request
    and gave an agent a job, all landing in the agency and in
    `person_actions`. It also ran through `npx` from a packed copy of the
    package.
  - **Cursor**: found the tools, called `list_agencies`, `agency_today`,
    `list_approvals`, `list_agents` and `list_requests`, and answered
    correctly.
  - **VS Code**: started it from `.vscode/mcp.json` and found all 31 tools
    ("Running | 31 tools"). Its chat needs a Copilot sign-in, so no question
    was asked there.
  - That testing found one bug, now fixed: with input closed straight after a
    call, the program quit before answering.

Published (2026-11-06):

- **npm**: `@extremely-agency/mcp` (`@extremely` was taken), org
  `extremely-agency`. 0.1.0 was published by hand; from then on the
  **Publish agency-mcp** workflow publishes, as the package's trusted
  publisher (this repo, `agency-mcp.yml`, environment `release`).
- **Official MCP registry**: `agency.extremely/agency`. The namespace is
  proved by a DNS TXT record on extremely.agency (`v=MCPv1; k=ed25519;
  p=...`); its private key stays on the owner's computer, never in a repo.
  Each new version is published there with `server.json` after npm.

Not yet:

- **The other directories** in the submission list above.
- **The installer**: the app installed before 2026-11-06 doesn't keep
  `agency-mcp.json`; a new installer from main does.
- **Not tried live**: Claude Desktop (it can't be restarted while it's in
  use, and the package is what its one-click connect already does), VS Code's
  chat (needs Copilot), and an organisation through the relay from a second
  computer.
- `npx` with a full Windows path to a local `.tgz` (`npx -y C:/.../x.tgz`)
  silently does nothing: npm's quirk, not ours. The published name and
  relative paths work.

The hosted HTTPS endpoint is separate: about 2 to 3 weeks (OAuth, per-org
routing, rate limits, connector-directory review).

## Open questions (for the owner)

1. **Package and registry names**: `@extremely-agency/mcp` (is the npm scope
   free or held?), and the registry namespace `agency.extremely/*`, which
   needs a DNS TXT record on extremely.agency that only the owner can add.
2. **Builder tools in the public package**, or a smaller "talk to your
   agency" set by default with the builder set behind a flag?
3. **Settings UI**: should Connectors show the `npx` command and the
   registries' install buttons? That's a UI change, so it's not in the
   estimate until approved.
4. **Members need their app open** for an org hosted elsewhere (the relay
   session lives in the app). Is that acceptable for v1? The alternative is
   a relay client inside the package, which would mean the package holding
   the org token: more work, and a second place that holds a sign-in.
5. **Linux**: settled (owner, 2026-11-13): the app ships for Windows, Mac and
   Linux at launch, like the package, so the listings say all three.
