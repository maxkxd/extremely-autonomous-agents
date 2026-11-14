# Store listing — EXTREMELY Autonomous Agents

Customers install this from the Chrome Web Store and from Microsoft Edge Add-ons. It is not inside the app installer. Chrome and Edge will not install a folder a customer is handed.

Unpacked id, from the `key` in `manifest.json` (development only): `cakbmeciolclkddbahjokaoependhhlp`

The stores assign their own ids on the first upload. The app does not use the id to talk to the extension, so that is fine. Write the published ids here after each store accepts the package.

- Chrome Web Store id:
- Edge Add-ons id:
- Privacy policy URL: `https://extremely.agency/privacy#browser-extension` (live since 14 Nov 2026, section 6a of the site's privacy policy)

Version: 0.1.0

Upload `dist/extremely-0.1.0.zip`. That zip leaves out this file, `PRIVACY.md`, and the development `key`. The folder you load unpacked keeps the key so the local id stays put.

## Where to submit

1. Chrome: [Chrome Web Store developer dashboard](https://chrome.google.com/webstore/devconsole). A Google account and a one-time $5 developer registration. Add new item, upload the zip, fill the tabs below, submit for review. Review is usually a few days and can be a few weeks, because this extension asks for cookies and every site.
2. Edge: [Partner Center, Edge extensions](https://partner.microsoft.com/dashboard/microsoftedge/overview). No fee. Create a new extension, upload the same zip, fill the same answers, Publish. Certification is usually within seven business days. Edge rejects a listing whose name or description says Chrome. This package says "this browser".

On both, set visibility to Public when you want every customer to find it. Hidden or unlisted still needs the same review, and only people with the link can install it.

After each listing is live, Connect Chrome and Connect Edge in the app should open that listing when the extension is not installed yet. Those buttons do not do that until the listing URLs exist.

## Single purpose

When an EXTREMELY agent has filled in a web form and a human check is in the way (Cloudflare Turnstile, reCAPTCHA, hCaptcha, a code), this extension opens that same page in the person's own Chrome or Edge with the form already filled in. The person passes the check and presses the site's submit button.

The extension does not solve checks. It does not run until the person presses Finish in EXTREMELY.

## Short description (132 characters or fewer)

Opens forms your EXTREMELY agents already filled, in this browser, so you can pass a check and press Submit.

## Permission justifications

**Cookies.** The agent's browser and this browser do not share a cookie jar. To open the page as the agent left it (a signup already in progress, a draft saved on the site), the extension sets that site's cookies for one tab, then puts the person's own cookies for that site back when the tab closes or the browser restarts. Only cookies for the registered domain of the page being opened are set or read (`siteCookies` in background.js drops any other domain a handoff lists). They are not sent anywhere except the EXTREMELY app on the same computer, so the agent can continue signed in.

**Storage.** Remembers the pairing with the local EXTREMELY app, and keeps a copy of the person's cookies for the one site until they are put back. Nothing is synced.

**Scripting.** Fills the fields the agent already filled (including passwords the agent typed into that form), restores that page's local storage, and notices when the person submits. A content script is registered for that site only while a handoff is open. It returns immediately on any tab that is not the handoff.

**Host access (`<all_urls>`).** The site is whichever one the agent was on. It is not known in advance, so the extension cannot ship a fixed host list. Access is used only for a site the person just asked to finish, plus `http://127.0.0.1` and `http://localhost` to talk to EXTREMELY on this computer. The loopback content script acts only on EXTREMELY's own two pages (`/person-chrome/connect` and `/person-chrome/go`) on its port, 5175, and pairing to any other address or port is refused.

**Not requested.** `tabs`, `debugger`, `webRequest`, `history`, `bookmarks`, native messaging. A later version may let the agent click and type in this browser through the scripting permission that is already here. It will not add the debugger. Attaching a debugger is what makes Cloudflare fail, which is the bug this extension exists to get around.

## Privacy tab

Remote code: No.

Data the extension handles, on the one site the person just agreed to finish: form field values (including a password the agent typed), cookies for that site, and that page's local and session storage.

That data moves between the EXTREMELY app and the browser on the same computer. It is not sold, not used for advertising, and not sent to an EXTREMELY server of ours. This version talks only to loopback. If a later version fetches a handoff from a cloud agency the person runs, update `PRIVACY.md` and this tab before that ships.

Certify the limited-use statements the dashboard shows. They match this policy.

Privacy policy URL: `https://extremely.agency/privacy#browser-extension`.

## Graphics

- Store icon: `icon128.png` (128×128).
- At least one screenshot, 1280×800, up to five. Use a real filled-in page with the bar at the bottom. Do not mock one.
- `store/screenshot-1-filled-form.png`: Future Tools' real Submit a Tool form, filled by the extension, with its bar (taken 14 Nov 2026; nothing submitted).

## Reviewer test

1. Install from the store listing under review, or load this folder unpacked at `chrome://extensions` or `edge://extensions` (Developer mode). Unpacked, the id is `cakbmeciolclkddbahjokaoependhhlp`.
2. Start EXTREMELY. Settings → Connectors → Signed-in browser → **Connect Chrome** or **Connect Edge**. The page should say this Chrome, or this Edge, is connected. The toolbar popup should say Connected.
3. Have an agent fill a form and call `signed_in_browser.show_person`. Press **Finish in your browser: the form is filled in**.
4. A new tab opens on that site in the browser that was connected. The fields the agent filled are filled. A bar at the bottom says to pass the check and press Submit. A file the agent attached has to be chosen again.
5. Pass the check and press the site's submit button. EXTREMELY marks the request done.
6. Close the tab without submitting on a second try. Cookies for that site are the person's own again (they were set aside only while the tab was open).
7. Visit any other site: the extension does not add the bar, does not change cookies, and does not read the page.

## What a reviewer should not see

- No remote code. Every script is in this package.
- No `eval` of fetched JavaScript.
- The content script on localhost only acts when the page is `/person-chrome/connect` or `/person-chrome/go` on port 5175 and carries EXTREMELY's meta tag.
- Passwords and cookie values are not written to the extension console. Counts and field names are.
