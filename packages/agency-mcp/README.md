# EXTREMELY agency for AI apps

Talk to your [EXTREMELY](https://extremely.agency) agency from Claude Desktop,
Cursor, VS Code, Claude Code, Windsurf or any app that speaks MCP:

- "What did my sales agent do today?"
- "What's waiting on me? Approve the email to Northside Bikes."
- "Answer the Engineer's request about the CRM key."
- "Give the research agent a job: find 20 bike shops in Leeds."
- "Show me the content agent's latest report." / "Run it now."

It needs the **Extremely Autonomous Agents** app running on the same computer
(free, open source: [extremely.agency](https://extremely.agency)). The app finds
everything itself, so there's nothing to set up here.

## Add it

Most people don't need this page: in the app, **Settings → Connectors → Your AI
assistant** connects Claude Desktop or Cursor in one click.

Any other app, or by hand: add an MCP server that runs

```
npx -y @extremely-agency/mcp
```

Claude Code:

```bash
claude mcp add extremely -- npx -y @extremely-agency/mcp
```

Cursor, VS Code and Claude Desktop (`mcpServers` in their MCP settings):

```json
{
  "mcpServers": {
    "extremely": { "command": "npx", "args": ["-y", "@extremely-agency/mcp"] }
  }
}
```

(VS Code's `.vscode/mcp.json` calls the list `servers` instead of `mcpServers`.)

## What it can do

Everything your role allows in the app, about 30 tools:

| | |
|---|---|
| What happened | `agency_today`, `agent_activity`, `latest_report`, `list_agents`, `read_agent` |
| Waiting on you | `list_approvals`, `decide_approval`, `list_requests`, `reply_to_request`, `answer_request` |
| Put agents to work | `give_task`, `run_agent`, `set_agent` |
| Build | `create_agent`, `write_agent_file`, `set_agent_models`, integrations (owners and admins) |
| Organizations | `list_agencies`; then `agency: "<name>"` on any tool |

Your AI app decides which tools it may call without asking you. Tools that are
hard to undo (deciding an approval, deleting an agent, publishing an
integration) are marked as destructive, so apps ask first by default.

## Organizations

With no `agency`, a tool works on your own agency. For an organization you're
in, name it (`list_agencies` shows them). For an organization hosted on
another computer, the app has to be open and signed in: it carries each message
to the organization's host, end to end encrypted. Our servers pass on bytes
they can't read. They never see your agency, keys or sign-ins.

## Settings (rarely needed)

- `EXTREMELY_MCP_URL`: one agency's MCP address, instead of finding the app
  (a self-hosted organization, or testing).
- `EAA_MCP_DISCOVERY`: where the app's address file is, if not the usual place
  (`%APPDATA%\Extremely Autonomous Agents\agency-mcp.json` on Windows,
  `~/Library/Application Support/...` on macOS, `~/.config/...` on Linux).

## License

AGPL-3.0-only. Source: [packages/agency-mcp](https://github.com/maxkxd/extremely-autonomous-agents/tree/main/packages/agency-mcp).
