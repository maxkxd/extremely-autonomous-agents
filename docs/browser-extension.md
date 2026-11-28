# The browser connector (EXTREMELY extension)

Agents browse in Chrome or Edge, through the EXTREMELY extension (`apps/person-chrome`): in the person's own browsers, and in **agents' profiles**, browser profiles the app owns and opens by itself ("Agent profiles", below). There's never a DevTools port, and no throwaway browser.

- **Connecting:** the person installs the extension, then pairs it with an agency in **Connectors > Browser**. Agents' profiles pair themselves.
- **Which profile:** any profile works, their everyday one or one made for agents. Each paired browser profile is one **browser**, numbered 1, 2, 3… in the agency where it was paired.
- **Tab groups:** agents work in tabs the extension opens in a **collapsed tab group per run**, titled with the agent's name.
- **Closing:** the tabs close when the run ends, unless the agent keeps one open or one is kept for a person's request.
- **The person's tabs:** the extension never reads, attaches to or closes them.
- **Pages for the person:** a page kept for a person (a CAPTCHA, a code, Google's sign-in) is a normal tab in that same browser, with the debugger detached. Google, Cloudflare and hCaptcha see an untouched browser.

Why: Google refuses every sign-in in a browser started with a debugging port ("This browser or app may not be secure"). A port-less browser driven by an extension doesn't have that problem.

## Pieces

| Piece | File | Job |
|---|---|---|
| Extension | `apps/person-chrome/` (MV3) | Relays DevTools commands to agent tabs through `chrome.debugger`. Manages agent tabs and tab groups. Pairs. Reconnects. |
| Link | `apps/server/src/runner/browser-link.ts` | WebSocket endpoint `/api/browser-link`, pairing, tokens, the list of paired browsers, and one `CdpConn` per online browser. |
| Browser | `apps/server/src/runner/browser.ts` | The agents' browser tools on top of `CdpPage`. Gets a browser's `CdpConn` from the link. |
| Agents' profiles | `apps/server/src/runner/agent-profiles.ts` | The app's own profile folders: finding Edge or Chromium, opening one with the extension loaded, numbering the folders. |
| Connectors UI | `apps/desktop/src/Integrations.tsx` (Browser card) | Pair a browser, list paired browsers, rename, remove, open an agents' profile, add one. |

## The relay: a DevTools browser, emulated by the extension

The server talks to an online browser exactly as it used to talk to a browser's DevTools address. `ExtensionCdp` (browser-link.ts) implements `CdpConn` (cdp.ts): `send(method, params, sessionId)`, `on(event, fn)`, `onClose`, `close`, `closed`. The extension answers a small, fixed set of browser-level `Target.*` and `Browser.*` methods itself. Everything sent with a `sessionId` goes to `chrome.debugger`.

### Wire format (one WebSocket per paired browser, JSON text frames)

Server to extension:
- `{ "id": 7, "method": "Page.navigate", "params": {...}, "sessionId": "t:123" }`, a command.
- `{ "type": "hello-ok", "browser": 2, "name": "Chrome - Work", "protocol": 1 }`, the reply to `hello`.
- `{ "type": "paired", "token": "...", "browser": 2, "name": "..." }`, the reply to `pair`.
- `{ "type": "error", "error": "..." }`, then the server closes.

Extension to server:
- `{ "type": "hello", "token": "...", "protocol": 1, "version": "0.2.0", "browser": "chrome" | "edge", "label": "<profile or user-chosen name>" }`. The first frame on a paired connection.
- `{ "type": "pair", "code": "K7Q2-9XPD", "token": "...", "protocol": 1, "version": "0.2.0", "browser": "chrome", "label": "..." }`. The first frame when pairing. `token` is the one this browser already holds for this agency, if it has one: sent so it pairs again into its own number.
- `{ "id": 7, "result": {...} }` or `{ "id": 7, "error": { "message": "..." } }`, a command's answer.
- `{ "method": "Page.loadEventFired", "params": {...}, "sessionId": "t:123" }`, an event.
- `{ "type": "ping" }` every 20 s. The server answers `{ "type": "pong" }`, and this keeps the MV3 worker alive.

Rules:
- The server closes a connection with no `hello` or `pair` within 10 s.
- A protocol it doesn't know gets `error` "Update the EXTREMELY extension".
- One live connection per browser number: a newer one replaces an older one.

### Ids

- **Target id** of a tab: `"t:<tabId>"` (a string).
- **Session id** of an attached tab: the same string, `"t:<tabId>"`.
- **Child sessions** (out-of-process iframes, via `Target.setAutoAttach` `flatten: true`) keep Chrome's own `sessionId`. The extension sends them with `chrome.debugger.sendCommand({ tabId, sessionId }, ...)` and forwards their events with that `sessionId`.
- Events from the tab itself carry `"t:<tabId>"`. A `Target.attachedToTarget` for an iframe arrives with the parent's session id, exactly like Chrome's.

### Browser-level methods the extension answers itself

Sent without a `sessionId`:

| Method | Extension does |
|---|---|
| `Target.createTarget {url, newWindow?, background?, eaaGroup?: {key, title, color?}}` | `url` must be `http(s)` or `about:blank`. `chrome.tabs.create({url, active: false})` in the agent window (below), added to the tab group for `eaaGroup.key`. The group is created collapsed, titled `eaaGroup.title`, and reused while it has tabs. Returns `{targetId: "t:<id>"}`. The tab becomes an **agent tab**. |
| `Target.attachToTarget {targetId, flatten: true}` | `chrome.debugger.attach({tabId}, "1.3")`, only for an agent tab (else an error "Not an agent tab"). Returns `{sessionId: "t:<id>"}`. Attaching an already-attached tab returns the same id. |
| `Target.detachFromTarget {sessionId}` | `chrome.debugger.detach`. The tab stays open and stays an agent tab. |
| `Target.closeTarget {targetId}` | `chrome.tabs.remove`, agent tabs only. Returns `{success}`. |
| `Target.activateTarget {targetId}` | Focus the tab's window, make the tab active, and expand its group. Agent tabs only. |
| `Target.getTargets` | `{targetInfos: [{targetId, type: "page", url, title, openerId?, attached}]}` for **agent tabs only**. `openerId` is `"t:<openerTabId>"` when the opener is an agent tab. |
| `Target.getTargetInfo {targetId}` | One of those. |
| `Target.setDiscoverTargets` | Accepted, no-op. Events are always sent (below). |
| `Browser.getWindowForTarget` / `Browser.setWindowBounds` | Resolve `{windowId, bounds}` from `chrome.windows`, and apply size to the agent window only. |
| `Browser.getVersion` | `{product, userAgent, protocolVersion: "1.3", extensionVersion}` |
| `EAA.groupTab {targetId, key, title, color?, collapsed?}` | Move an agent tab into another group, for example a "Waiting on you" group that isn't collapsed. |
| `EAA.tabGroup {targetId}` | Read-only: the group an agent tab is in, `{groupId, title, collapsed, color, windowId, active}`, or `{groupId: -1, active}` when it's in none. |
| `EAA.releaseTab {targetId}` | Stop treating it as an agent tab. It leaves its group, is detached and stays open. This is what the person keeps. |
| `EAA.downloads {since}` | Downloads started from agent tabs since a time: `{items:[{id, url, filename, state, bytes, startTime, tabTargetId?}]}`. |
| `EAA.downloadFile {id}` | `{base64, mime, filename}` for a finished download (up to 50 MB), read through `fetch` of its file URL where allowed. If it isn't readable, an error saying so. |
| Anything else without `sessionId` | `error` "Not supported in the extension: <method>". `Target.createBrowserContext`, `Storage.getCookies` and `Storage.setCookies` included. |

**Agent window:**
- Agent tabs open in the browser's last-focused normal window, so collapsed groups sit quietly at the end of the strip.
- If no normal window exists, the extension creates one with `focused: false` (unfocused, minimized when the platform allows).

**Popups:** a tab or window opened by an agent tab the debugger is on (`chrome.tabs.onCreated` with an `openerTabId` that's an attached agent tab, or `chrome.webNavigation.onCreatedNavigationTarget`) becomes an agent tab too, joins its opener's group, and is reported to the server. What's opened from a detached agent tab (a page kept for the person, a tab kept open) is the person's: never listed, so never swept.
- Chrome opens a `target=_blank` tab in front. Unless the tab in front before it was an agent tab (one shown to the person), the extension gives the front back to the person's tab and collapses the group again.

### Events the extension sends without a `sessionId`

- `Target.targetCreated {targetInfo}`: a new agent tab, including popups.
- `Target.targetInfoChanged {targetInfo}`: an agent tab's url or title changed.
- `Target.targetDestroyed {targetId}`: an agent tab closed. Also `EAA.tabClosedByPerson {targetId}` when the extension didn't close it for a `closeTarget`.
- `Target.detachedFromTarget {sessionId, targetId}`: the debugger detached. Includes the reason, for example `canceled_by_user` when the person dismissed the debugging bar.

### Sent with `sessionId` = `"t:<tabId>"` or a child session

`chrome.debugger.sendCommand(source, method, params)`, where `source` is `{tabId}` or `{tabId, sessionId}`. The result or error is passed back. `chrome.debugger.onEvent` is forwarded with the right session id.

What `chrome.debugger` can't do, or what would reach past the tab, is reported as an error. The server must never depend on it:
- `Browser.*`
- `Target.*` other than `setAutoAttach`, `detachFromTarget` and `getTargetInfo` (for the tab itself)
- `Target.createBrowserContext`
- the whole profile's cookies: `Network.getAllCookies`, `Network.clearBrowserCookies`, `Storage.getCookies`, `Storage.setCookies`, `Storage.clearCookies`
- `Page.navigate` to anything but `http(s)` or `about:blank` (no `file://`, `chrome://`)

### What the extension never does

- It never attaches to, reads, lists or closes a tab that isn't an agent tab.
- It never hands over the profile's cookies: no agency, paired or not, can read every site's sign-in in one call.
- It keeps no remote code. All logic is in the package.

### State the extension keeps

- `chrome.storage.local`: pairings, a list of `{url, token, browser, name}`. A browser may be paired with more than one agency, each a separate connection.
- `chrome.storage.session`: agent tabs `{tabId: {agencyUrl, groupKey}}` and groups `{key: groupId}`. This survives worker restarts but not browser restarts.
- `chrome.storage.local`, `eaaAgentTabs`: a small record that outlives a restart, `{v: 1, agencies: {<agencyUrl>: [{url, title, color, waiting}]}}`. One entry per agent tab in a group: its address and its group's title and color (the color Chrome has; Chrome picks one when none was given). Written about a second after the agent tabs change (opened, navigated, regrouped, closed).
- After a browser restart there are no agent tabs. The server sees `Target.getTargets` without the old ones and handles kept pages it can't find as lost.

### Restored tabs after a restart

Chrome may restore the last session. The agent tabs and groups come back with new tab ids, which nothing knows, so they'd sit in the person's window for good. So:
- At the start of a browser session (no session state yet), the extension takes the record as "last session" and starts a new record.
- On `chrome.runtime.onStartup`, and on each agency's first connection (`hello-ok`) in the session, it looks at every tab in a group. A tab is a restored agent tab only when its group's title and color match a recorded group **and** its address matches a recorded agent tab of that group.
- A restored agent tab is closed. A restored "Waiting on you" tab (group key `waiting`) is the person's: it stays open and is taken out of the group, a normal tab. The server has already counted kept pages as lost.
- Nothing else is touched: a tab of the person's, one in a group of theirs, or one an agency opened in this session.
- An agency's part of the record is used once, on its first connection; a removed pairing's is dropped. A worker restart within the same browser session sweeps nothing.

### Tab groups and closing

- A run's group key is the run id, and its title is the agent's name.
- When a run ends, the server closes its tabs (`Target.closeTarget`), except kept ones.
- When a connection comes back after a server restart, the server sends `Target.getTargets` and closes agent tabs that belong to no live run and no kept page.

## Pairing

1. In Connectors > Browser the person presses **Connect a browser**. The agency (`POST /api/browser/pair`) makes a one-time code (`XXXX-XXXX`, 10 minutes) and returns:
   - `{ code, url, link }`, where `url` is the WebSocket address the extension should use, and
   - `link`, the one-string pairing value `eaa1:<base64url({u: url, c: code, n: agencyName})>`.
2. Two ways in:
   - **This browser:** the app opens `http://127.0.0.1:<app port>/browser/connect#<link>` in the default browser. The extension's content script on loopback reads the hash and pairs. If the extension isn't installed, the page says so, with the store links.
   - **Another profile:** the person copies `link` into the extension's popup (**Pair with EXTREMELY**, then paste).
3. The extension connects to `url` and sends `{type: "pair", code}`. The server checks the code (one use, unexpired) and assigns the next browser number. It stores `sha256(token)` in the vault (`browser-link`, never the token itself) and replies `paired` with the token. The browser is online on that connection from then on; later connections start with `hello`.
4. **Pairing again** (Connect this browser in a browser that's paired already, or a link pasted into it again): the extension sends the token it holds for that agency with the code. If the agency knows it, the browser keeps its number and its name: a new token replaces the old one, which stops working, and an older connection still open is replaced. Its saved accounts and kept pages are under that number, so it must not become a new browser and leave the old one listed offline. An unknown or missing token pairs as a new browser. An agents' profile's own code always pairs into that profile's number.

**Address `url`:**
- The agency's own address as the browser reaches it: `ws://127.0.0.1:<its port>/api/browser-link` when it runs on this computer.
- **An organization hosted on this computer:** its agency runs with `PORT=5185` (hosting.ts) and listens on loopback, so the address is `ws://127.0.0.1:5185/api/browser-link`. The extension connects to it directly; the person's own agency (5175) isn't in between.
- **Hosted in the cloud:** `wss://<its public host>/api/browser-link`, from `EAA_PUBLIC_URL`, or on Railway `https://$RAILWAY_PUBLIC_DOMAIN` when that isn't set. The container's only public listener is the link front (`src/link-forward.ts`, started by `scripts/cloud-host.ts` on `PORT`). It passes WebSocket upgrades on `/api/browser-link` to the agency inside the container and answers everything else with a 404. Path: browser, `wss://` (TLS ends at the platform's edge), the front on `PORT`, then `ws://127.0.0.1:<agency port>/api/browser-link`.
- **Self-hosted** (an organization at its own address): the app passes `<address>/hosted` as `base`, giving `wss://<address>/hosted/api/browser-link`. The host's own agency passes that upgrade on to the organization's agency on 5185.
- Otherwise the address the app reached it at, passed by the app as `base` in the pair request.

**Forwarding hops** (`src/link-forward.ts`): a hop ends the browser's WebSocket and opens its own to the agency, then passes frames both ways, close codes included. Only WebSocket frames reach the agency, never a raw HTTP request (which it would take as coming from this computer). The hop passes `Origin` on and adds no sign-in of its own: the link checks the code or token, and the extension's origin, as it always does. A refusal by the agency (403 for a web page's origin) comes back as the same status; an agency that isn't up gives a 502, and the extension tries again.

**Rules:**
- Loopback connections and any `wss` connection are accepted only with a valid token or code.
- `Origin` must be `chrome-extension://…`, or absent in tests.

**`GET /api/browser`:** `{ browsers: [{ n, name, kind: "chrome"|"edge", online, since, agentTabs, version, managed, paired }], storeLinks: { chrome?, edge? }, profiles: { available, kind?: "edge"|"chromium", why? } }`. `managed` is an agents' profile; `profiles` says whether the app can open them here, and why not. `paired` is when it was last paired: after Connect a browser, the app says "Browser connected" for a new number, or for a known one whose `paired` changed while it's online.

Routes:
- `POST /api/browser/rename {n, name}`
- `POST /api/browser/remove {n}`: revokes the token. A live connection gets `error` and is closed. For an agents' profile only the pairing goes: the number and folder stay, and it pairs again when it next opens.
- `POST /api/browser/open {n}`: opens agents' profile `n` now (a person's Open, so a recent failure doesn't hold it back) and answers once it's online, or with why it didn't come online.
- `POST /api/browser/new-profile`: makes the next agents' profile and opens it: `{ok, n, error?}`.
- `POST /api/browser/show {request}`: focuses the kept tab for a request.

## The agents' tools (browser.ts)

- `signed_in_browser.*` drives browser `n`: the tool argument `browser`, defaulting to the browser where the agent last worked, else the lowest-numbered online one, else an agents' profile the app can open (an offline one counts: it opens by itself). With no browser at all, where the app can make profiles, the first agents' profile is made.
- The old `profile` argument is still accepted as an alias.
- The throwaway `browser.*` tools are gone. Reading a page without signing in uses the same browser.
- **An offline agents' profile:** the tool opens it and goes on once it's online ("Agent profiles").
- **No browser online and none the app can open** (no agents' profile, or no Edge or Chromium here): the tool answers plainly, with why profiles can't open, and files one request, "Connect a browser" (not again while it's open).
- **`show_person`:** the tab is detached, moved to a "Waiting on you" group (not collapsed) and released from the run. The request's button calls `POST /api/browser/show`, which activates it. When the person closes it, the request is answered and the agent hears.
- **`show_person` with `google: true`:** opens `https://accounts.google.com/` as a released, never-attached tab in that browser and focuses it. Done when the person closes it.
- **Password store:** keyed by browser number (formerly profile number; numbers carry over). When every browser already holds 10 accounts on a site, `start_sign_up` makes the next agents' profile for the new one (where the app can; otherwise it says to connect another profile).

## Agent profiles

Browser profile folders the app owns, `<data>/browser-profiles/<n>`, which it opens itself as normal browsers with the extension loaded. Agents never wait for a person to "open browser 1".

- **Number:** folder `n` is browser `n`, the number the password store uses too. The link keeps the number for the profile before it's paired (`managed: true`, its folder in `dir`, an empty token hash until it pairs). A person's browser never gets a number a profile folder is waiting for.
- **The browser:** the one shipped with the app, Chrome for Testing (`EAA_BROWSER_DIR`, staged by `apps/electron/scripts/stage-browser.cjs` for Windows x64 and Mac, signed with the app), so it's the same whichever browser the person uses. Branded Chrome (137+) and Edge (158+) switch off an extension given with `--load-extension`; Chrome for Testing keeps it. Where none is shipped (Windows on Arm, Linux, development), the computer's Edge, else Chromium (`EAA_PROFILE_BROWSER` names another). A folder Edge made opens in Edge again while Edge is there (its sign-ins are sealed with Edge's keys). With only Chrome on the computer and nothing shipped, the app says so, and the person pairs a browser themselves.
- **Edge's switched-off extension:** Edge keeps a record of an extension it switched off (`disable_reasons` 1<<24 in `Secure Preferences`); before each start the app drops that record for the command-line extension (`forgetDisabledExtension`), and starts Edge with `--disable-features=DisableLoadExtensionCommandLineSwitch,...` so it isn't switched off again. A profile already open with the extension switched off (left by an earlier version) is closed - asked first, forced after 15 s, matched by its own `--user-data-dir` only - and opened again, rather than given more connect pages that can only say "Not connected".
- **The start:** `--user-data-dir=<folder> --load-extension=<extension> --no-first-run --no-default-browser-check`, three flags that keep background tabs at full speed, and, while it isn't paired, the connect page as its start page, with a pairing code for that profile's number (`pairCode({browser: n, local: true})`, always over loopback). Never `--remote-debugging-*`, so Google's sign-in works in it. Detached, its own process: it stays open when the app quits, with whatever pages it has for the person.
- **Already paired:** started plainly; its extension says hello by itself. If it hasn't within 20 s (the extension's storage was cleared), the connect page goes to it and it pairs again into the same number.
- **Already running** (its lock is held: `lockfile` on Windows, `SingletonLock` elsewhere): not started again. A stale lock from a crash or another machine is cleared first. Only an unpaired one gets the connect page, handed to the running browser.
- **On demand:** a browser tool that needs an offline agents' profile opens it and waits up to 40 s. Two runs needing it share one opening. If it doesn't come online, the tool says why, and one request, "Agents' profile n didn't open", asks the person to press Open (or connect a browser). The profile isn't tried again for 10 minutes, except by Open. The request is answered when it comes online.
- **The extension:** in development `apps/person-chrome`; in the installed app a copy of its runtime files (`build/stage/extension`, staged by `apps/electron/scripts/stage.cjs`), found through `EAA_EXTENSION_DIR`, which the desktop app sets. The manifest keeps its `key`, so the extension's id, and the pairing it keeps, doesn't change.
- **Folders from before:** the app used to run these folders itself, with a debug port. At start, every numbered folder that looks like a profile (`Local State` or `Default/`) and isn't numbered yet becomes browser `n`, "Agents' profile n". If a person's browser was paired as `n` first, the person's keeps it: the folder takes the next free number, and its accounts in the password store (those made before that browser was paired) move with it. Logged either way.
- **Connectors > Browser:** an agents' profile shows as "Agents' profile n · Edge", with **Open** while it's offline, and no Remove. **Add an agents' profile** makes and opens the next one, where the app can open them.
- **Hosted:** only where a browser is installed on the agency's own computer. An organization hosted on this computer opens its profiles from its own data folder. The cloud image has no browser, so a cloud agency has no agents' profiles: its members pair their own browsers.
