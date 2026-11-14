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
import { ackChromeFinished, chromeFinished, copyForChrome, finishForChrome, openPersonChrome, personChromeStatus, stageInChrome } from './builder';

const agencyHere = () => {
  const org = currentOrg();
  return !org || reachedHere(org);
};

// "Open in my Chrome": the kept page for this request, in the person's browser.
export async function openInMyChrome(request: number) {
  const { handoff } = await copyForChrome(request);
  if (agencyHere()) await openPersonChrome(handoff.id);
  else await stageInChrome(handoff);
}

// What the person's browser finished, sent on to an agency hosted elsewhere. Asked of
// this computer's own server every few seconds, focused or not: they're in Chrome
// when they finish, and the agent is waiting on it.
const RELAY_MS = 4000;
export function relayChromeFinished(): () => void {
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
  void tick();
  const timer = window.setInterval(() => void tick(), RELAY_MS);
  return () => window.clearInterval(timer);
}

// A request whose kept page shows a human check opens in the person's Chrome by
// itself, once, if that browser is connected (an unconnected one would only get the
// install page each time). Remembered per agency, so a restart doesn't open it again.
const openedKey = () => `eaa.chromeOpened.${currentOrg()?.id ?? 'here'}`;
const readOpened = (): number[] => {
  try {
    const v = JSON.parse(localStorage.getItem(openedKey()) ?? '[]') as unknown;
    return Array.isArray(v) ? v.filter((n): n is number => typeof n === 'number') : [];
  } catch {
    return [];
  }
};
const saveOpened = (ids: number[]) => {
  try {
    localStorage.setItem(openedKey(), JSON.stringify(ids.slice(-200)));
  } catch {
    // Storage unavailable: it may open again after a restart.
  }
};
let opening = false;
export async function openChecksInChrome(requests: { id: number; status: string; captcha?: boolean }[]) {
  if (opening) return;
  const opened = readOpened();
  const due = requests.filter(r => r.status === 'open' && r.captcha && !opened.includes(r.id));
  if (!due.length) return;
  opening = true;
  try {
    const st = await personChromeStatus().catch(() => null);
    if (!st?.connected) return;
    for (const r of due) {
      saveOpened([...readOpened(), r.id]);
      await openInMyChrome(r.id).catch(e => console.error(`[person-chrome] request #${r.id} did not open in Chrome:`, (e as Error).message));
    }
  } finally {
    opening = false;
  }
}
