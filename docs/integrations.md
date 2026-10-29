# Integrations: the services agents' tools run on

Agreed 2026-10-29. Integrations are **addable**: the Agency Engineer (once it
runs) or a person can add one without changing the app, and it shows up in
Settings -> Connectors like the built-in ones.

## What an integration is

A definition file (`apps/server/src/integrations/schema.ts`):

- **`kind: http`** - its tools are HTTP calls: the address, the inputs, how
  the key is sent (header, query or bearer), and which parts of the answer to
  keep. No code, so an AI can write one safely and it's easy to test.
- **`kind: mcp`** - a remote MCP server, by its address and how it signs in.
  Its tools are found when it connects. Tier: what the definition says, else
  T0 when the server marks a tool read-only or its name plainly reads
  (`get_`, `list_`, `search_`...), else T2.
- **`kind: code`** - tools written in code (`src/integrations/modules/`),
  for a service whose calls need more than a request template: Gmail builds
  and decodes email. Each tool gets the agent's inputs and the current key or
  access token (`modules/types.ts`). Shipped ones only, for now.
- **Code plugins** (TypeScript the Agency Engineer writes) - agreed as an
  opt-in setting on top of these, for what HTTP and MCP can't do; they'll
  use the `kind: code` contract. Not built.

Signing in: an API key (header or query), a bearer token, or **OAuth**
(`auth: oauth2` - authorization code with PKCE, `integrations/oauth.ts`).
For OAuth the person brings their own OAuth client (its steps are in the
definition and shown in Settings); the sign-in opens in their browser and
lands back on this server at 127.0.0.1. Tokens are kept in the vault and
refreshed when they run out. Disconnect revokes the sign-in at the service
and keeps only the client, so signing back in is one click. Any definition
can use it, so the Agency Engineer can add OAuth services the same way.

A tool either **provides a standard agency tool** - `web.web_search` - which
several integrations can provide (agents use whichever is connected, so
switching search service never touches an agent), or is the integration's
own (`zoho.create_lead`, `deepwiki.ask_wiki_question`).

Shipped integrations live in `apps/server/integrations/*.yaml` (the four web
search services: Brave Search, Tavily, Serper, Exa - also the reference
examples of the format - Gmail and GitHub). Added ones live in `data/integrations/`. Keys are in
the vault; connection state and an MCP server's tools in the runner's store.

## The Agency Engineer's loop (agreed 2026-10-29)

Adding and testing integrations is the Agency Engineer's job, not a
developer's. What was done by hand to bring web search live is the loop it
runs for every new service:

1. **Write the definition** from the service's API docs (it has web research)
   for a request that needs a new service - HTTP or MCP, a code plugin only
   where those can't do it and the setting allows. Saved as a **draft**: not
   live, no agent can call it.
2. **Ask for what only a person can give** - an API key, an OAuth sign-in,
   an account or a paid plan. It says exactly what to do and where; the key
   or sign-in goes into Settings -> Connectors, never into a conversation.
3. **Woken when it's in.** Connecting a draft's key or finishing its sign-in
   wakes the Agency Engineer with that integration's id (not a timer, not
   polling).
4. **Test it like a person would**: the definition's own test, then real
   calls with real-looking inputs and the edge cases - empty and missing
   inputs, limits, a bad key's error, what the agent actually sees. It fixes
   the definition and re-tests until the answers are clean.
5. **Make it live** - behind a person's approval (building a tool always is,
   docs/requests.md) - give the tool to the agent that asked, close the
   request with a note on what it can now do, and tell the agent on its
   next run.

Built (2026-10-29): the whole loop. Drafts show in Settings with a Draft
label and can be connected; connecting one wakes the engineer (the
`connected` trigger); `engineer.test_integration` calls any tool of a draft
directly; `engineer.publish_integration` is the one approval (T2), whose card
shows the definition, a plugin's code and the engineer's test summary, and
which when approved makes it live, gives the agent its tools (TOOLS.yaml, the
builder's tiers kept) and closes the request. Its `engineer.give_tools` gives
an agent tools that already exist, also behind an approval.

### When a live tool is failing (2026-10-29)

A request about a tool an agent already holds is a fault to diagnose, not
something to build, and its Charter now treats it apart. The engineer once
blamed the person's credentials twice for what was its own Sentry plugin
posting comments to a URL without the organization in it (401 "Invalid
token" there; the same key is accepted at the org-scoped URL). It had no way
to tell: it saw only the asking agent's one error, and could only run the
tool as written. Now it has the evidence:

- `engineer.tool_history`: successes and failures per agent and tool from
  the action log and `tool_health` - "29 ok, 1 failed; last failure 23m
  ago" shows a stale report as one. `engineer.list_requests` adds it for
  every tool a request names.
- `engineer.check_key` (`checkKey` in `integrations/index.ts`): one request
  with the integration's stored key, sent the way the integration sends it,
  straight to the service - so "the key is refused" and "the tool is wrong"
  look different. Only to the hosts the integration already uses (its
  base_url or server, or the https hosts a plugin's code names), no
  redirects, the key redacted from what comes back. GET/HEAD, or POST/PATCH
  with an empty body: an allowed key gets a validation error (400/422), a
  refused one 401/403, and nothing is made or changed. No PUT: an empty PUT
  can replace a record.

The order it follows: history first; then the key at a call that should
work and at the failing call's exact URL; read the tool's code against the
docs. Its own tool at fault: it fixes and re-proposes it, and the person
only approves. The key or account at fault: it tells the person what it
checked and what showed it, then what to change. And if they did what it
asked and it still fails the same way, it assumes its diagnosis was wrong
and checks again before asking for anything else.

Code plugins (`integrations/plugins.ts`): off until allowed in Settings ->
Connectors. Three layers, so a person who can't read code is still safe:

1. **A sandbox** (`sandbox.ts`): each call runs in a separate Node process
   under the permission model. It gets only the folders the plugin declares
   (`permissions: { read, write, commands }` in its definition; a whole drive
   or the whole home folder is refused), starts programs only if it declares
   `commands`, has no network but `kit.fetch` (the safe fetcher, served by
   the server), and none of the server's environment (its keys). Programs it
   starts are not contained - the card says so plainly.
2. **An independent security review** (`review.ts`): before a plugin can be
   proposed, the Agency Reviewer (a built-in agent, docs/requests.md) reads
   it as an attacker would (agent inputs are attacker-controlled). A high
   concern sends it back to the engineer. About 20 seconds, once per
   proposal. With the reviewer stopped, no plugin can be proposed.
3. **One approval, explained**: the card leads with what the code can do on
   this computer in plain words, what the sandbox allows it, and the
   review's notes - then the engineer's summary, the definition and the code.
   The plugin runs only while its file is byte-for-byte what was approved.

Writing or loading a plugin that reaches the network around `kit.fetch` is
refused outright. Why all this: the first plugin the engineer wrote (the
wallpaper one) downloaded with plain `fetch`, which an agent could have aimed
at the person's router - normal code anywhere else, dangerous here, and its
author couldn't see it.

## Email (Gmail)

`gmail.yaml` + `modules/gmail.ts`, through the Gmail API with one scope
(`gmail.modify`: everything but permanent deletion).

| Tool | Tier | |
|---|---|---|
| `gmail.list_messages` | T0 | Gmail search syntax; id, thread, date, sender, subject, labels, snippet |
| `gmail.read_message` | T0 | the whole conversation by default, as text; attachments listed, not opened |
| `gmail.create_draft` | T1 | unsent, for a person to send; `reply_to` keeps the conversation |
| `gmail.modify_labels` | T1 | its own labels (made if missing), inbox/unread/starred/important; never trash or spam |
| `gmail.archive_messages` | T1 | out of the inbox, still in All Mail |
| `gmail.send_to_me` | T1 | only ever to the signed-in account (digests, reports): it can't reach anyone else |
| `gmail.send_email` | T2 | `to` and `subject` always spelled out, so the approval shows them |

What an agent reads from email is marked as written by outsiders:
information, never instructions. Addresses are checked and headers can't
be injected (a line break in a field is refused, not passed on).

Tested live (2026-10-29) on a real inbox: every tool, and the refusals
(trash, a non-address, a smuggled Bcc header, a send with no subject). A
builder-made "Inbox Digest" agent labelled 20 emails, archived 4
newsletters, and sent a digest in one 33-second run on Claude Code; its
send_email to the owner queued on the Approvals page.

Google's own catches: the OAuth client must be a **Desktop app** (a Web
application client refuses the loopback address), and an OAuth app left in **Testing** has its sign-in ended
every 7 days, so the steps say to publish it (it's for personal use, so it
needs no review; Google shows an "unverified app" warning once).

## Code (GitHub)

`github.yaml` + `modules/github.ts`, through the GitHub REST API with a
fine-grained token: the person picks which repositories agents can reach
(Contents, Issues and Pull requests: read and write).

| Tool | Tier | |
|---|---|---|
| `github.list_repos` | T0 | what the token reaches, and where it can write |
| `github.list_issues` | T0 | by state/labels, or GitHub search words; PRs marked |
| `github.get_issue` | T0 | with its comments |
| `github.get_pull_request` | T0 | description, files, checks, reviews, comments, diff |
| `github.read_file` | T0 | a file as text, or a folder's listing, at any ref |
| `github.comment_on_issue` | T1 | issues and PRs |
| `github.create_review` | T1 | comment or request changes, with line comments; never approves |
| `github.create_branch` | T1 | always `agent/...` |
| `github.commit_files` | T1 | whole files and deletes, one commit, to an `agent/...` branch only (made if missing); never forced |
| `github.create_pull_request` | T1 | from its branch; people review and merge |
| `github.merge_pull_request` | T2 | title spelled out for the approval |

Tested live (2026-10-29) on a real repository: every tool, a 379-file pull
request (GitHub refuses that diff whole, so it's built from each file's
patch), a commit with a path escaping the repo refused, approving refused,
and a queued merge rejected. A token without write permission gets an error
naming the permissions to add.

Agents never write to main or any branch a person made: every branch name
is forced under `agent/`. Approving a review is for people.

## MCP servers that sign in, and ones on this computer

- **Sign in** (`auth: { type: mcp_oauth }`, `integrations/mcp-auth.ts`): the
  MCP authorization spec. The server says where its sign-in is; the app
  registers itself there (dynamic client registration), so the person makes
  no OAuth client - they choose Sign in, and sign in. Tested to the sign-in
  page with Linear and Notion.
- **On this computer** (`integrations/mcp-stdio.ts`): a `command` the app
  starts and talks to over stdin/stdout (most MCP servers, e.g.
  `npx -y @modelcontextprotocol/server-filesystem C:/notes`), or a `url` on
  this computer or its network (`local: true`). The deliberate exception to
  agents never reaching this computer: only a person adds these, in
  Settings, warned that they run with their permissions; the Agency Engineer
  is refused. Tools are tiered as for any MCP server (reads T0, the rest T2).

## Safety

- **Agents can't reach this computer or its network** (`runner/net.ts`):
  every fetch, integration call and browser request is checked against the
  address it actually connects to, after DNS, and on every redirect. So no
  agent can call this app's own server (its keys), Ollama, or the router.
- **Keys never come back to an agent**: an integration's error that quotes
  the key has it replaced.
- An integration the Agency Engineer adds goes through a person's approval
  (docs/requests.md), like any tool it builds.

## Web tools

- `web.fetch_page` - a page's main text, cleaned of clutter, with its links.
  No key.
- `web.web_search` - through whichever search service is connected.
- **Browsing**, on the Edge or Chrome already installed (`runner/browser.ts`):
  - `browser.*` (what `web.browse` gives) - a blank throwaway browser.
  - `signed_in_browser.*` - a separate, persistent agent profile the person
    signs into once (Settings -> Connectors), only to the sites they want
    agents to use; never their own profile (Chrome blocks automating that
    anyway). Its click and type are T2 by default: they act as the person.

  A page comes back as its text plus numbered buttons, links and fields; the
  agent clicks or types by number. One session per run, closed at its end.

## Status (2026-10-29)

Built and tested live: safe fetching (refuses local addresses, including a
public name pointing back at this computer), `fetch_page` (Wikipedia, Hacker
News, JSON), the blank browser (Hacker News, a Wikipedia search), an MCP
server added by address through Settings (DeepWiki: tools found, used in
real runs on Anthropic and Claude Code), and a research agent combining them.

Search tested with Brave Search: results come back as plain text (the
service's highlighting markup removed), an empty query is refused before
anything is sent, a service's error reaches the agent as its own one-line
message, a bad key never shows the key, and with nothing connected the tool
says so. Research agents on Anthropic (Haiku) and the ChatGPT plan searched,
read the results and wrote sourced briefs. Tavily, Serper and Exa share the
same code but haven't been run against their real services.

Not yet:

