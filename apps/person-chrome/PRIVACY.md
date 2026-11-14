# EXTREMELY Autonomous Agents — browser privacy policy

Last updated 14 November 2026.

EXTREMELY is an extension for the EXTREMELY app, for Google Chrome and Microsoft Edge. It opens a web form an EXTREMELY agent has already filled, in your own browser, so you can pass a human check (such as Cloudflare) and press Submit.

## What it handles

For the one site you just agreed to finish:

- the form fields the agent filled in, which can include a password the agent created for that signup
- that page's local storage and session storage
- cookies for that site (its own domain only, never another site's), so the page opens the way the agent left it

Before it does that, it saves your own cookies for that site and puts them back when you close the tab, when you finish, or when the browser next starts if a finish was interrupted.

## Where it goes

The filled-in page is read from the EXTREMELY app on the same computer (`127.0.0.1`). After you submit, cookies for that site are sent back to that same app so the agent can continue signed in.

This data is not sold, not used for advertising, and not sent to a server operated as a general EXTREMELY service. It stays between your browser and your EXTREMELY app.

The extension does not read other sites. A script that can run on the site you are finishing returns immediately on any tab that is not that handoff.

## How long it is kept

EXTREMELY deletes its copy of the page when you finish, or after 7 days. The browser deletes the backup of your own cookies as soon as they are restored.

## Removing it

Remove the extension in `chrome://extensions` or `edge://extensions`. Disconnect or reset it in EXTREMELY under Settings → Connectors → Signed-in browser. Resetting means the browser must be connected again, and the previous pairing stops working.
