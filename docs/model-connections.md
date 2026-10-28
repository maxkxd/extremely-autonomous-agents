# AI model connections

How agents get a model to run on (Settings > Connectors). Researched October
2026; each provider's rules change, so re-check before relying on them.

## Three kinds of connection

- **Your AI plans** - a subscription the person already pays for, connected
  through that provider's own sanctioned route.
- **API keys** - checked live against the provider before they're saved.
- **On this computer** - a local model server (Ollama).

Credentials never reach the app: keys and tokens go to the server, are
encrypted at rest (AES-256-GCM, `apps/server/data/vault.json`, key in
`vault.key` or `EAA_VAULT_KEY`), and the app only ever sees "connected", a
masked hint (`sk-ant…fgAA`) and a model count. `data/` is gitignored.

## Plans: what each provider allows

| Provider | Route | Status |
|---|---|---|
| **Claude** (Pro/Max) | The person's own **Claude Code**, signed in through Anthropic's own flow | Allowed. Anthropic does **not** allow apps to offer Claude.ai login, route requests through Free/Pro/Max credentials, or collect/store Claude credentials or session tokens. It does allow an end user to sign in to the **unmodified** Claude Code binary with their own plan, including where a product runs Claude Code - so that's the route. One button does whatever's next: **Install Claude Code** (Anthropic's official installer in a terminal window), **Sign in to Claude** (`claude auth login --claudeai` in a terminal window - Anthropic's own login), then it connects by itself. This app only reads `claude auth status` (signed in or not; an API key in the environment doesn't count). Plan limits assume ordinary individual use, so a busy fleet can hit them. Running Claude Code inside a product requires the Commercial Terms and these conditions: binary unmodified, each user authenticates themselves, no reselling/intermediating usage. [Anthropic: Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance) |
| **ChatGPT** (Go/Plus/Pro) | **Sign in with ChatGPT** (OAuth + PKCE, dynamic client registration, Responses API on the plan) | Official since DevDay 2026. Self-serve for open-source and locally hosted apps; **a paid or remotely hosted app needs OpenAI's approval via their interest form before it ships**. Users set per-app weekly caps at chatgpt.com/settings/usage. Implemented from the documented protocol - OpenAI's devkit is noncommercial-licensed, so it isn't used. [OpenAI: Sign in with ChatGPT](https://developers.openai.com/siwc) |
| **GitHub Copilot** (Pro/Pro+/Business/Enterprise, and the free student plan) | GitHub OAuth App device sign-in, then the official **Copilot SDK** (MIT) | Official (Copilot SDK GA June 2026). Usage bills to each user's own Copilot plan; models include Claude, GPT and Gemini. With an app sign-in, `listModels()` can come back empty while prompts work (Copilot picks the model) - tested on a student plan. [GitHub: Copilot SDK OAuth setup](https://docs.github.com/en/copilot/how-tos/copilot-sdk/setup/github-oauth) |
| Google Gemini (AI Pro/Ultra) | - | **Not allowed.** Google prohibits third-party use of Gemini CLI's login and has suspended accounts for it; the consumer Pro/Ultra path is deprecated. Use an AI Studio key. |
| xAI (SuperGrok) | - | **Not yet.** A few partners accept SuperGrok sign-in, but there's no open developer program; tools that do it reuse the Grok CLI's client ID. Use an API key. |
| GLM / Kimi / MiniMax / Qwen coding plans | - | Not offered: their plan keys are generally limited to coding tools. |

## API keys

Anthropic, OpenAI, Google Gemini (AI Studio), OpenRouter, xAI, Mistral,
DeepSeek, Groq, and **Other (OpenAI-compatible)** with a base URL - which covers
Azure OpenAI, Together, Fireworks, LM Studio, vLLM and gateways. Each key is
checked by listing the provider's models before it's saved.

**OpenRouter** also has **Sign in**: its official PKCE flow hands the app a
user-owned key (with whatever spend limit they set) - no copying keys.

The agent builder uses the Anthropic key from Connectors if there is one,
otherwise `ANTHROPIC_API_KEY` from `apps/server/.env`.

## Setting up GitHub Copilot (once, for the product)

Copilot sign-in needs a GitHub OAuth App registered for this product:

1. GitHub > Settings > Developer settings > OAuth Apps > **New OAuth App**
   (or under the organization that will own the product).
2. Name it, set the homepage URL (`https://extremely.agency`), and any callback URL (device sign-in doesn't
   use it, e.g. `http://127.0.0.1:5175/`).
3. Tick **Enable Device Flow**, then **Register application**.
4. Copy the **Client ID** into `apps/server/.env` as
   `GITHUB_OAUTH_CLIENT_ID=...` and restart the server. No client secret is
   needed for device sign-in.

## Before launching the paid hosted plan

The product is open-source and self-hosted, with a paid hosted plan (the
Snipe-IT model). The self-hosted version is "open-source and locally hosted",
which is OpenAI's self-serve case. Only the hosted plan needs more:

- **OpenAI**: submit the Sign in with ChatGPT interest form for the hosted (paid) offering.
- **Anthropic**: running Claude Code in a product is under the Commercial
  Terms; for anything beyond the conditions above, contact Anthropic sales.

## Still open

- Agents don't run yet (no runtime), so a connection is saved and checked, but
  nothing calls it on an agent's behalf yet. ChatGPT plan requests must set
  `store: false` and `stream: true`, with `input` as a list of messages (tested:
  `scripts/chatgpt-test.ts`); Claude Code runs via the `claude` CLI, not
  the Agent SDK with plan credentials.
- Amazon Bedrock and Google Vertex need cloud credentials rather than a key.

## Which models an agent runs on

Each agent has **up to three models, in order** (`data/agent-models.json`, and
`models:` in its TOOLS.yaml), each a model on one connection with an effort
level (low / medium / high / max). #1 runs; #2 and #3 take over when it can't.

- **The builder picks them** (custom agents and pack customization): the best
  fit for the job from what's connected, preferring plans over pay-per-use
  keys, and spread across connections so one outage doesn't stop the agent.
  With nothing connected the agent is still created, with no models, and its
  card's Model row is flagged.
- **Falling back** (`apps/server/src/models/health.ts`, tested): a model that
  fails to run is benched - 2 minutes, doubling per failure in a row, an hour
  at most - and the next choice runs. One success clears it. If every
  connected choice is benched, the one that comes back soonest is tried.
- **On the card**: the Model row under Est. Output shows #1 and its effort.
  Clicking it slides the right column over the pies and opens the picker:
  slots 1-3, effort, search, and every connected provider as a group that
  opens with its arrow. Click away to close.
- Copilot picks its own model, so it offers one choice: "auto".

### Only models that can run an agent, with honest effort

`apps/server/src/models/caps.ts` (tested). An agent needs a model that takes
text, writes text and calls tools. When a connection is made, its list is cut
to those, and each model's effort levels are recorded; the picker and the
builder only ever see that list.

| Connection | Agent-capable | Effort levels |
| --- | --- | --- |
| Anthropic | all listed | `capabilities.effort` per model (Haiku 4.5: none) |
| OpenRouter | text in and out, and `tools` in `supported_parameters` | `reasoning.supported_efforts` (a reasoning model that lists none: no setting) |
| Gemini | `generateContent` models | low/medium/high if `thinking` |
| ChatGPT plan | listed models | its `supported_reasoning_levels` |
| Ollama | `tools` in `/api/show` capabilities | low/medium/high for gpt-oss |
| Claude plan | Opus, Sonnet, Haiku | all four (`claude --effort`) |
| OpenAI, xAI, Groq | known model names | known families (o-series, gpt-5+, grok-3-mini, gpt-oss) |
| Mistral, DeepSeek, custom, Copilot | known model names | none |

Every provider's list also goes through a filter of known non-chat names
(embeddings, speech, images, moderation, realtime, search previews...).

Our levels map onto each provider's own: low/medium/high as named, and **max**
is the provider's `max`, or its `xhigh` when it has no max (levels above max,
like ChatGPT's `ultra`, aren't offered). Where the name differs it's saved per
model (`native` in `data/connections.json`); **the runner sends
`nativeEffort(connection, model, level)`**, never our name blindly, and fits a
saved level to the model's list first (`fitEffort`), as the card does. A model
with no setting, or only one level, shows the Effort row greyed out ("Not
adjustable for this model") and the runner sends none. The builder's pick is
moved to the nearest level the model takes.

Verified live (2026-10-28): the ChatGPT plan models call function tools and
honour `low`, `xhigh` and `max`. Not yet verified with a real connection:
Gemini's `thinking` flag, Ollama's `/api/show`, and the name-based rules for
OpenAI, xAI, Groq, Mistral and DeepSeek. An agent that already holds a model its connection no
longer offers is flagged on its card like an agent with no model.

Connections saved before this check (`caps` missing in
`data/connections.json`) are checked again when the server starts.

## Running an agent on Claude Code (for the runtime)

Tested on a Claude plan (`scripts/claude-code-test.ts`). Without isolation,
`claude -p` loads the person's own setup - their claude.ai connectors, plugins,
hooks and skills - and answers as their assistant. An agent must only ever
have its own tools, so every agent run is isolated:

    claude -p <task> --output-format json       --setting-sources "" --strict-mcp-config --mcp-config <the agent's servers>       --tools "" --disable-slash-commands --system-prompt <the agent's Charter>

run in its own empty working folder, with `ANTHROPIC_API_KEY` /
`ANTHROPIC_AUTH_TOKEN` removed from its environment so it uses the Claude
account. Asked to list its tools, an isolated session answers "none". Don't use
`--bare`: it isolates too, but refuses the Claude account login.
