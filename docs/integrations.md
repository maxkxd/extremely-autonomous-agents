# Integrations: the services agents' tools run on

Agreed 2026-10-29. Integrations are **addable**: the Fleet Engineer (once it
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
- **Code plugins** (TypeScript the Fleet Engineer writes) - agreed as an
  opt-in setting on top of these, for what HTTP and MCP can't do. Not built.

A tool either **provides a standard agency tool** - `web.web_search` - which
several integrations can provide (agents use whichever is connected, so
switching search service never touches an agent), or is the integration's
own (`zoho.create_lead`, `deepwiki.ask_wiki_question`).

Shipped integrations live in `apps/server/integrations/*.yaml` (the four web
search services: Brave Search, Tavily, Serper, Exa - also the reference
examples of the format). Added ones live in `data/integrations/`. Keys are in
the vault; connection state and an MCP server's tools in the runner's store.

## The Fleet Engineer's loop (agreed 2026-10-29)

Adding and testing integrations is the Fleet Engineer's job, not a
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
   wakes the Fleet Engineer with that integration's id (not a timer, not
   polling).
4. **Test it like a person would**: the definition's own test, then real
   calls with real-looking inputs and the edge cases - empty and missing
   inputs, limits, a bad key's error, what the agent actually sees. It fixes
   the definition and re-tests until the answers are clean.
5. **Make it live** - behind a person's approval (building a tool always is,
   docs/requests.md) - give the tool to the agent that asked, close the
   request with a note on what it can now do, and tell the agent on its
   next run.

Needs, none built yet: draft integrations; OAuth sign-in; the wake on
connect (a new trigger, alongside scheduled, self-booked, handoff, your
message and approval); the Fleet Engineer's own tools (write / test / fix /
publish an integration, give a tool to an agent); approvals that actually
run when approved; and the Fleet Engineer running at all.

## Safety

- **Agents can't reach this computer or its network** (`runner/net.ts`):
  every fetch, integration call and browser request is checked against the
  address it actually connects to, after DNS, and on every redirect. So no
  agent can call this app's own server (its keys), Ollama, or the router.
- **Keys never come back to an agent**: an integration's error that quotes
  the key has it replaced.
- An integration the Fleet Engineer adds goes through a person's approval
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

- **OAuth sign-in** for integrations (Zoho-style, and MCP servers that need
  it) - only no-sign-in, API key and bearer token so far.
- **Code plugins**, and the **Fleet Engineer** adding integrations (its loop is above).
- **MCP servers on this computer** (local addresses are refused, like
  everything else agents reach).
- **PDFs** in `fetch_page`.
