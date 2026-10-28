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

Not yet:

- **Search** is untested against a real key: none is connected yet.
- **OAuth sign-in** for integrations (Zoho-style, and MCP servers that need
  it) - only no-sign-in, API key and bearer token so far.
- **Code plugins**, and the **Fleet Engineer** adding integrations.
- **MCP servers on this computer** (local addresses are refused, like
  everything else agents reach).
- **PDFs** in `fetch_page`.
