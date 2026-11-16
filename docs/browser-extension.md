# The browser connector (EXTREMELY extension)

Agents browse in the person's own Chrome or Edge, through the EXTREMELY extension (`apps/person-chrome`). The app never starts a browser of its own. There's no DevTools port, no profile folders and no throwaway browser.

- **Connecting:** the person installs the extension, then pairs it with an agency in **Connectors > Browser**.
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
| Connectors UI | `apps/desktop/src/Integrations.tsx` (Browser card) | Pair a browser, list paired browsers, rename, remove. |

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
- `{ "type": "pair", "code": "K7Q2-9XPD", "protocol": 1, "version": "0.2.0", "browser": "chrome", "label": "..." }`. The first frame when pairing.
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
| `Target.createTarget {url, newWindow?, background?, eaaGroup?: {key, title, color?}}` | `chrome.tabs.create({url, active: false})` in the agent window (below), added to the tab group for `eaaGroup.key`. The group is created collapsed, titled `eaaGroup.title`, and reused while it has tabs. Returns `{targetId: "t:<id>"}`. The tab becomes an **agent tab**. |
| `Target.attachToTarget {targetId, flatten: true}` | `chrome.debugger.attach({tabId}, "1.3")`, only for an agent tab (else an error "Not an agent tab"). Returns `{sessionId: "t:<id>"}`. Attaching an already-attached tab returns the same id. |
| `Target.detachFromTarget {sessionId}` | `chrome.debugger.detach`. The tab stays open and stays an agent tab. |
| `Target.closeTarget {targetId}` | `chrome.tabs.remove`, agent tabs only. Returns `{success}`. |
| `Target.activateTarget {targetId}` | Focus the tab's window, make the tab active, and expand its group. Agent tabs only. |
| `Target.getTargets` | `{targetInfos: [{targetId, type: "page", url, title, openerId?, attached}]}` for **agent tabs only**. `openerId` is `"t:<openerTabId>"` when the opener is an agent tab. |
| `Target.getTargetInfo {targetId}` | One of those. |
| `Target.setDiscoverTargets` | Accepted, no-op. Events are always sent (below). |
| `Browser.getWindowForTarget` / `Browser.setWindowBounds` | Resolve `{windowId, bounds}` from `chrome.windows`, and apply size to the agent window only. |
| `Browser.getVersion` | `{product, userAgent, protocolVersion: "1.3", extensionVersion}` |
| `Storage.getCookies {browserContextId?}` / `Storage.setCookies {cookies}` | `chrome.cookies.getAll({})` / `chrome.cookies.set`, in DevTools cookie shape. |
| `EAA.groupTab {targetId, key, title, color?, collapsed?}` | Move an agent tab into another group, for example a "Waiting on you" group that isn't collapsed. |
| `EAA.tabGroup {targetId}` | Read-only: the group an agent tab is in, `{groupId, title, collapsed, color, windowId, active}`, or `{groupId: -1, active}` when it's in none. |
| `EAA.releaseTab {targetId}` | Stop treating it as an agent tab. It leaves its group, is detached and stays open. This is what the person keeps. |
| `EAA.downloads {since}` | Downloads started from agent tabs since a time: `{items:[{id, url, filename, state, bytes, startTime, tabTargetId?}]}`. |
| `EAA.downloadFile {id}` | `{base64, mime, filename}` for a finished download (up to 50 MB), read through `fetch` of its file URL where allowed. If it isn't readable, an error saying so. |
| Anything else without `sessionId` | `error` "Not supported in the extension: <method>". `Target.createBrowserContext` included. |

**Agent window:**
- Agent tabs open in the browser's last-focused normal window, so collapsed groups sit quietly at the end of the strip.
- If no normal window exists, the extension creates one with `focused: false` (unfocused, minimized when the platform allows).

**Popups:** a tab or window opened by an agent tab (`chrome.tabs.onCreated` with an `openerTabId` that's an agent tab, or `chrome.webNavigation.onCreatedNavigationTarget`) becomes an agent tab too, joins its opener's group, and is reported to the server.
- Chrome opens a `target=_blank` tab in front. Unless the tab in front before it was an agent tab (one shown to the person), the extension gives the front back to the person's tab and collapses the group again.

### Events the extension sends without a `sessionId`

- `Target.targetCreated {targetInfo}`: a new agent tab, including popups.
- `Target.targetInfoChanged {targetInfo}`: an agent tab's url or title changed.
- `Target.targetDestroyed {targetId}`: an agent tab closed. Also `EAA.tabClosedByPerson {targetId}` when the extension didn't close it for a `closeTarget`.
- `Target.detachedFromTarget {sessionId, targetId}`: the debugger detached. Includes the reason, for example `canceled_by_user` when the person dismissed the debugging bar.

### Sent with `sessionId` = `"t:<tabId>"` or a child session

`chrome.debugger.sendCommand(source, method, params)`, where `source` is `{tabId}` or `{tabId, sessionId}`. The result or error is passed back. `chrome.debugger.onEvent` is forwarded with the right session id.

What `chrome.debugger` can't do is reported as an error. The server must never depend on it:
- `Browser.*`
- `Target.createTarget` from inside a session
- `Target.createBrowserContext`

### What the extension never does

- It never attaches to, reads, lists or closes a tab that isn't an agent tab.
- It never sends cookies anywhere except to the agency it's paired with, and only when the agency asks (`Storage.getCookies`).
- It keeps no remote code. All logic is in the package.

### State the extension keeps

- `chrome.storage.local`: pairings, a list of `{url, token, browser, name}`. A browser may be paired with more than one agency, each a separate connection.
- `chrome.storage.session`: agent tabs `{tabId: {agencyUrl, groupKey}}` and groups `{key: groupId}`. This survives worker restarts but not browser restarts.
- After a browser restart there are no agent tabs. The server sees `Target.getTargets` without the old ones and handles kept pages it can't find as lost.

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

**Address `url`:**
- The agency's own address as the browser reaches it: `ws://127.0.0.1:<its port>/api/browser-link` when it runs on this computer.
- `wss://<its public host>/api/browser-link` when it's hosted. That uses `EAA_PUBLIC_URL` if set, otherwise the address the app reached it at, passed by the app as `base` in the pair request.

**Rules:**
- Loopback connections and any `wss` connection are accepted only with a valid token or code.
- `Origin` must be `chrome-extension://…`, or absent in tests.

**`GET /api/browser`:** `{ browsers: [{ n, name, kind: "chrome"|"edge", online, since, agentTabs, version }], storeLinks: { chrome?, edge? } }`.

Routes:
- `POST /api/browser/rename {n, name}`
- `POST /api/browser/remove {n}`: revokes the token. A live connection gets `error` and is closed.
- `POST /api/browser/show {request}`: focuses the kept tab for a request.

## The agents' tools (browser.ts)

- `signed_in_browser.*` drives browser `n`: the tool argument `browser`, defaulting to the browser where the agent last worked, else the lowest-numbered online one.
- The old `profile` argument is still accepted as an alias.
- The throwaway `browser.*` tools are gone. Reading a page without signing in uses the same browser.
- **No browser online:** the tool answers "No browser is connected right now. Do other work; you'll be able to browse when the person's browser is online." and files one request, "Connect a browser" (not again while it's open).
- **`show_person`:** the tab is detached, moved to a "Waiting on you" group (not collapsed) and released from the run. The request's button calls `POST /api/browser/show`, which activates it. When the person closes it, the request is answered and the agent hears.
- **`show_person` with `google: true`:** opens `https://accounts.google.com/` as a released, never-attached tab in that browser and focuses it. Done when the person closes it.
- **Password store:** keyed by browser number (formerly profile number; numbers carry over).
