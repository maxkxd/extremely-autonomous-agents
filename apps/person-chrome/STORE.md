# Store listing — EXTREMELY Autonomous Agents

Customers install this from the Chrome Web Store and from Microsoft Edge Add-ons. It is not inside the app installer. Chrome and Edge will not install a folder a customer is handed.

Unpacked id, from the `key` in `manifest.json` (development only): `cakbmeciolclkddbahjokaoependhhlp`

The stores assign their own ids on the first upload. The app does not use the id to talk to the extension, so that is fine. Write the published ids here after each store accepts the package.

- Chrome Web Store id:
- Edge Add-ons id: `lpnecgpodgaabojgddcjhchajceboild` (Store ID 0RDCKCMC0WBM). 0.2.0 submitted 2026-11-16, in review. Listing: https://microsoftedge.microsoft.com/addons/detail/lpnecgpodgaabojgddcjhchajceboild
- Privacy policy URL: `https://extremely.agency/privacy#browser-extension` (section 6a of the site's privacy policy). Update that section to match `PRIVACY.md` before 0.2.0 is submitted.

Version: 0.2.0

Make the upload with `node apps/person-chrome/pack.mjs`. It writes `apps/person-chrome/dist/extremely-0.2.0.zip` (not committed). That zip leaves out this file, `PRIVACY.md`, `test/`, `pack.mjs` and the development `key`. The folder you load unpacked keeps the key so the local id stays put.

Tests: `node --test apps/person-chrome/test/`.

## Where to submit

1. Chrome: [Chrome Web Store developer dashboard](https://chrome.google.com/webstore/devconsole). A Google account and a one-time $5 developer registration. Upload the zip as a new version of the existing item (or a new item before the first one is published), fill the tabs below, submit for review. Expect a longer review than 0.1.0: this version asks for `debugger` and every site.
2. Edge: [Partner Center, Edge extensions](https://partner.microsoft.com/dashboard/microsoftedge/overview). No fee. Upload the same zip, fill the same answers, Publish. Certification is usually within seven business days. Edge rejects a listing whose name or description says Chrome. This package says "this browser".

On both, set visibility to Public when you want every customer to find it. Hidden or unlisted still needs the same review, and only people with the link can install it.

## What changed from 0.1.0

0.1.0 only reopened a form an agent had filled elsewhere, so the person could pass a check and press Submit. It said a later version would not add the debugger, because the agents' own browser then failed Cloudflare and Google checks.

0.2.0 replaces that. The agents no longer have a browser of their own: they work in the person's browser, in tabs of their own, through this extension. The debugger is how the extension drives those tabs. It is never attached to a tab the person opened, and a page handed to the person for a check or a sign-in has the debugger detached first, so the site sees an ordinary browser. The 0.1.0 handoff (form copying and cookie swapping) is gone.

## Single purpose

Lets your EXTREMELY agents use this browser: they work in their own collapsed tab groups and hand you pages to finish.

The person pairs the extension with their EXTREMELY agency. The agency's agents then open tabs in this browser, each run in one collapsed tab group titled with the agent's name, and click, type and read in those tabs only. When a page needs the person (a CAPTCHA, a code, a sign-in), the agent detaches, moves the tab to a "Waiting on you" group and asks the person to finish it there.

## Short description (132 characters or fewer)

Lets your EXTREMELY agents use this browser: they work in their own collapsed tab groups and hand you pages to finish.

## Permission justifications

**Debugger.** Drives only the tabs the agents open (and the pop-ups those tabs open): loading pages, clicking, typing, reading the page, screenshots. Never the person's own tabs: the extension refuses to attach to, read, list or close a tab it did not open for an agent. It is detached from any tab handed to the person, and from every tab when the person presses Pause.

**Tabs.** Opens the agents' tabs in the background, reports their address and title to the agency for those tabs only, focuses one when the person asks to see it, and closes them when the run ends. Notices when the person closes an agent tab.

**Tab groups.** Keeps each run's tabs in one collapsed group titled with the agent's name, so they stay out of the person's way, and moves a page waiting on the person into an expanded "Waiting on you" group.

**Web navigation.** Notices when an agent tab opens a pop-up or a new tab (for example a "Sign in with..." window), so that tab belongs to the agent too and joins its group.

**Downloads.** Lists files downloaded by agent tabs and reads a finished one (up to 50 MB) for the agency. Downloads the person makes in their own tabs are not listed.

**Storage.** Remembers the pairings (agency address and a token), the pause switch and this browser's name, and, for the current browser session only, which tabs are agent tabs.

**Alarms.** Every 30 seconds, reconnects a pairing whose connection dropped, because Chrome stops idle extension workers.

**Host access (`<all_urls>`).** The agents' tabs can be on any site the agent's job needs, and downloads are per site. The only content script is on `http://127.0.0.1` and `http://localhost`, and it acts only on EXTREMELY's pairing page (`/browser/connect`), to pair this browser. A pairing link for an agency on another computer asks the person before it pairs.

**Not requested.** `cookies`, `webRequest`, `history`, `bookmarks`, `scripting`, native messaging.

## Privacy tab

Remote code: No. All logic is in the package. The agency sends DevTools commands (data), not code to load.

Data the extension handles: in the agents' own tabs, page content and screenshots the agent asks for; addresses and titles of those tabs; files downloaded by agent tabs.

That data goes only to the EXTREMELY agency the person paired with: on the same computer (`ws://127.0.0.1`), or the person's own hosted agency over `wss`. It is not sold, not used for advertising, and not sent anywhere else.

Certify the limited-use statements the dashboard shows. They match this policy.

Privacy policy URL: `https://extremely.agency/privacy#browser-extension`.

## Graphics

- Store icon: `icon128.png` (128×128).
- At least one screenshot, 1280×800, up to five. Use real ones: an agent's collapsed tab group in the tab strip, the "Waiting on you" group with a page for the person, and the toolbar popup. Do not mock them. The 0.1.0 screenshot of a filled-in form no longer shows what this version does.

## Reviewer test

1. Install from the store listing under review, or load this folder unpacked at `chrome://extensions` or `edge://extensions` (Developer mode). Unpacked, the id is `cakbmeciolclkddbahjokaoependhhlp`.
2. Start EXTREMELY. Connectors → Browser → **Connect a browser**. A page opens in this browser and says it is paired. The toolbar badge turns green, and the popup lists the agency as online.
   - Another profile: copy the pairing link from the same card and paste it in the popup under **Pair with EXTREMELY**.
3. Run an agent that browses. A collapsed tab group titled with the agent's name appears at the end of the tab strip. Chrome shows its "started debugging this browser" bar while the agent works.
4. Open the group: the agent's tabs are there. Your own tabs are untouched.
5. Have an agent call `signed_in_browser.show_person`. The page moves into an expanded "Waiting on you" group, the debugger is detached from it, and EXTREMELY's request button focuses it.
6. When the run ends, its group closes.
7. Press **Pause agents** in the popup. The badge says II, the debugging bar goes away, and an agent that tries to browse is told the person paused agents in this browser.

## What a reviewer should not see

- No remote code. Every script is in this package.
- No `eval`.
- The debugger is never attached to a tab the person opened. The extension refuses such requests (tested in `test/relay.test.js`).
- Cookie values and page content are not written to the extension console.
