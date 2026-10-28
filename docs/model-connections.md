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
| **Claude** (Pro/Max) | The person's own **Claude Code**, signed in through Anthropic's own flow | Allowed. Anthropic does **not** allow apps to offer Claude.ai login, route requests through Free/Pro/Max credentials, or collect/store Claude credentials or session tokens. It does allow an end user to sign in to the **unmodified** Claude Code binary with their own plan, including where a product runs Claude Code - so that's the route. This app only reads `claude auth status` (signed in or not; an API key in the environment doesn't count). Plan limits assume ordinary individual use, so a busy fleet can hit them. Running Claude Code inside a product requires the Commercial Terms and these conditions: binary unmodified, each user authenticates themselves, no reselling/intermediating usage. [Anthropic: Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance) |
| **ChatGPT** (Go/Plus/Pro) | **Sign in with ChatGPT** (OAuth + PKCE, dynamic client registration, Responses API on the plan) | Official since DevDay 2026. Self-serve for open-source and locally hosted apps; **a paid or remotely hosted app needs OpenAI's approval via their interest form before it ships**. Users set per-app weekly caps at chatgpt.com/settings/usage. Implemented from the documented protocol - OpenAI's devkit is noncommercial-licensed, so it isn't used. [OpenAI: Sign in with ChatGPT](https://developers.openai.com/siwc) |
| **GitHub Copilot** (Pro/Pro+/Business/Enterprise) | GitHub OAuth App device sign-in, then the official **Copilot SDK** (MIT) | Official (Copilot SDK GA June 2026). Usage bills to each user's own Copilot plan; models include Claude, GPT and Gemini. [GitHub: Copilot SDK OAuth setup](https://docs.github.com/en/copilot/how-tos/copilot-sdk/setup/github-oauth) |
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

## Before selling the product

- **OpenAI**: submit the Sign in with ChatGPT interest form for a paid app.
- **Anthropic**: running Claude Code in a product is under the Commercial
  Terms; for anything beyond the conditions above, contact Anthropic sales.

## Still open

- Agents don't run yet (no runtime), so a connection is saved and checked, but
  nothing calls it on an agent's behalf yet. ChatGPT requests must set
  `store: false` and `stream: true`; Claude Code runs via the `claude` CLI, not
  the Agent SDK with plan credentials.
- Amazon Bedrock and Google Vertex need cloud credentials rather than a key.
