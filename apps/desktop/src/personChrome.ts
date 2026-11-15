// The person's own Chrome (apps/person-chrome), for a check the agents' browser can't
// pass - Cloudflare's "Verify you are human" above all. The agency copies the page it
// kept, filled in as the agent left it; the app hands the copy to the browser on this
// computer; the person passes the check and presses Submit there; and the sign-in it
// leaves goes back to the agents' browser.
//
// When the agency runs on this computer it does all of that itself. When it's hosted
// elsewhere (the cloud) it can't reach this computer's browser, so the app carries the
// copy there and what was finished back (server: runner/person-chrome.ts, app routes).

import { currentOrg, reachedHere } from './account';
import { ackChromeFinished, chromeFinished, copyForChrome, finishForChrome, finishNow, finishedElsewhere, showKeptHere, stageInChrome } from './builder';

const agencyHere = () => {
  const org = currentOrg();
  return !org || reachedHere(org);
};

// "Open in my browser": the kept page for this request. On the computer that runs the
// agency it's right here, in the agents' browser: that window comes to the front, on
// the page as the agent left it. Hosted elsewhere, a copy opens in the person's own
// Chrome or Edge (the extension).
export async function openInMyChrome(request: number) {
  if (agencyHere()) {
    await showKeptHere(request);
    return;
  }
  const { handoff } = await copyForChrome(request);
  await stageInChrome(handoff);
}

// What the person's browser finished, sent on to an agency hosted elsewhere. Asked of
// this computer's own server every few seconds, focused or not: they're in Chrome
// when they finish, and the agent is waiting on it.
const RELAY_MS = 4000;
let busy = false;
const tick = async () => {
    if (busy || agencyHere()) return;
    busy = true;
    try {
      const { finished } = await chromeFinished();
      for (const f of finished) {
        try {
          await finishForChrome(f.id, f.cookies);
          await ackChromeFinished(f.id);
        } catch (e) {
          const why = (e as Error).message;
          // The agency already has it, or let it go: nothing more to send.
          if (/no longer waiting|Unknown page/i.test(why)) await ackChromeFinished(f.id).catch(() => {});
          else console.error('[person-chrome] could not send a finished page to the agency:', why);
        }
      }
    } catch {
      // This computer's server is starting or gone: next time.
    } finally {
      busy = false;
    }
};
export function relayChromeFinished(): () => void {
  void tick();
  const timer = window.setInterval(() => void tick(), RELAY_MS);
  return () => window.clearInterval(timer);
}

// Finished, pressed in the app: the person did it in their own browser. That browser
// sends the page back with the sign-in it holds if it still has the tab; otherwise
// (they closed it) the agency is told they're done, and the agent checks for itself.
export async function finishedInMyBrowser(request: number) {
  const r = await finishNow(request).catch(e => {
    console.error(`[person-chrome] request #${request}: this computer's browser could not be asked:`, (e as Error).message);
    return { viaBrowser: false };
  });
  if (r.viaBrowser) {
    if (!agencyHere()) await tick();
    return;
  }
  await finishedElsewhere(request);
}
