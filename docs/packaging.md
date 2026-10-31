# Packaging: the downloadable app

Windows first (2026-10-30); Mac once Windows is solid and Apple Developer is
approved. The app is Electron (`apps/electron`) around the same agency that
runs in development.

## What the app is

- **Electron's own Node runs the agency** (`ELECTRON_RUN_AS_NODE`): one runtime
  shipped, not two. `apps/server` ships as its source, run with `tsx` exactly as
  in development (`--import tsx src/index.ts`), so every path it reads - shipped
  integrations, packs, plugin sources, the sandbox - works unchanged. An
  organisation the computer hosts, and the plugin sandbox, start the same way.
- **The agency serves the app.** With `EAA_UI_DIR` set (only in the packaged
  app), `apps/server/src/ui.ts` serves the built `apps/desktop` at the same
  address as `/api`. The root still takes a service's sign-in callback (it
  carries `state`).
- **Per-person data.** `%APPDATA%/Extremely Autonomous Agents/data`
  (`EAA_DATA_DIR`), logs beside it in `logs/agency.log`.
- **Fixed ports: 5175, 5176, 5185.** 5175 is the sign-in callback people
  register with Google, Zoho and the like, so it can't move. If they're taken
  (another copy, a development server), the app says so and doesn't start.
- **The window closes to the tray**: agents keep working. Quit is in the tray
  menu, as is "Start with Windows" (starts hidden). One copy at a time.
- **The agency goes with the app** however it ends: it watches the app's
  process (`EAA_APP_PID`, `hosting.ts`), so a crash can't leave it holding the
  ports.
- **Google and GitHub sign-in happen in the person's browser**: they refuse
  embedded windows. The app opens its own address in the browser, the sign-in
  happens there, and a single-use Clerk ticket (`/me/sign-in-ticket` on the
  backend) comes back to the app through the agency (`handoff.ts`, guarded by a
  code only the app knows, ten minutes, this computer only). The browser is
  signed back out. Email codes sign in inside the window as before.
- **Copilot works out of the box**: its GitHub OAuth client id is public and
  built in (`GITHUB_OAUTH_CLIENT_ID` still overrides it).
- **What it doesn't ship**: Claude Code, the Copilot CLI's sign-in, Cloudflare's
  tunnel, Chrome or Edge for the agents' browser. The app finds them, and offers
  to install Claude Code, as in development.

## Updates

`electron-updater` checks GitHub Releases at start and every six hours. When
one has downloaded, the person chooses when to restart; then both agencies
(their own, and an organisation's they host) go on standby, running agents
finish (up to half an hour), it installs, and each agency is set back to how it
was on the next start. Never installed on quit, never mid-run.

## Building

On Windows, with Node 24:

    cd apps/electron
    npm ci
    npm run dist          # stage + installer in apps/electron/dist

`scripts/stage.cjs` assembles `build/stage`: the server with its production
dependencies, the built app (`VITE_EAA_BACKEND_URL` and
`VITE_CLERK_PUBLISHABLE_KEY` from the environment or `apps/desktop/.env.local`) -
and no Node of its own, since Electron's runs it. `scripts/after-pack.cjs` copies the server's
`node_modules` in after packing - electron-builder won't copy a `node_modules`
through `extraResources`.

To try a build beside a running development server: `EAA_APP_PORT`,
`EAA_HOOKS_PORT` and `EAA_HOSTED_PORT` move it, and `--hidden
--user-data-dir=<folder>` keeps it out of sight and away from real data.

## Releasing

`.github/workflows/release.yml`, only ever run by hand (Actions > Release >
Run workflow, with a version). It runs in the protected `release` environment
(a person approves it), builds, and publishes a **draft** release; publishing
the draft is what makes it the update. In that environment:

- variables: `EAA_BACKEND_URL`, `CLERK_PUBLISHABLE_KEY`; for signing,
  `AZURE_SIGNING_ENDPOINT`, `AZURE_SIGNING_ACCOUNT`, `AZURE_CERTIFICATE_PROFILE`
- secrets (signing): `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`

Without the Azure secrets the installer is built unsigned, with a warning.

## Open

- **Signing**: Azure Trusted Signing and Apple Developer applied for.
- **Size**: about 170 MB - mostly the Copilot runtime (156 MB unpacked) that
  `@github/copilot-sdk` bundles for everyone, Copilot or not. Fetching it only
  when someone connects Copilot would roughly halve the download.
- The installer's name has no version in it (`Extremely-Autonomous-Agents-Setup.exe`), so
  `https://github.com/maxkxd/extremely-autonomous-agents/releases/latest/download/Extremely-Autonomous-Agents-Setup.exe`
  always gets the newest - that's the website's Download link.
