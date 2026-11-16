# EXTREMELY Autonomous Agents — browser privacy policy

Last updated 16 November 2026. Published at `https://extremely.agency/privacy#browser-extension`.

EXTREMELY is an extension for the EXTREMELY app, for Google Chrome and Microsoft Edge. It lets your EXTREMELY agents use this browser: they work in their own collapsed tab groups and hand you pages to finish.

## What changed

Version 0.1.0 only reopened a form an agent had filled, so you could pass a check and press Submit. Version 0.2.0 lets agents work in this browser directly, in tabs they open themselves, using the browser's debugger for those tabs only. The 0.1.0 form and cookie handoff is gone.

## What it handles

In the tabs the agents open (and pop-ups those tabs open), never in your own tabs:

- the pages: what the agent reads, clicks and types, and screenshots it takes
- those tabs' addresses and titles
- files those tabs download

It never reads or hands over this browser profile's cookies as a whole: the agents use the sign-ins you have the way a person does, by working on the site.

The extension never attaches to, reads, lists or closes a tab it did not open for an agent. A page handed to you (a CAPTCHA, a code, a sign-in) has the debugger detached before you see it. **Pause agents** in the toolbar popup detaches it from every tab and stops new agent tabs until you resume.

## Where it goes

Only to the EXTREMELY agency you paired this browser with: the app on the same computer (`127.0.0.1`), or your own hosted agency over an encrypted (`wss`) connection. A browser paired with more than one agency keeps them apart: each one sees only the tabs it opened.

This data is not sold, not used for advertising, and not sent to a server operated as a general EXTREMELY service.

## What it keeps

- In the browser's extension storage: each pairing (the agency's address, its name, and a token that proves the pairing), the pause switch, and the name you gave this browser.
- For the current browser session only: which tabs are agent tabs, and which downloads came from them. This is gone when the browser restarts.

What the agency keeps about its agents' work is covered by the rest of this policy and the agency's own settings.

## Removing it

Remove a pairing in the toolbar popup, or remove this browser in EXTREMELY under Connectors → Browser; either stops that agency's access. Remove the extension in `chrome://extensions` or `edge://extensions` to stop all of it.
