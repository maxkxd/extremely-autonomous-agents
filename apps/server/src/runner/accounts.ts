import { randomBytes } from 'node:crypto';
import { FLEET_ENGINEER } from './agent.js';
import { all, one, run as exec } from './db.js';
import { deletePassword, passwordRow, savePassword, siteOf, makePassword } from './passwords.js';
import { providerName, providerPage, signInOf, signInWords, type SignIn } from './signin.js';

// The accounts agents owe (docs/accounts.md): every website account an agent has to
// have - one it was built to need, or one it said it needs - is written down here
// before anyone starts signing up, and stays owed until the app itself has seen it
// work, or a person says they don't want it.
//
// Why a record of its own: an agent's word was all there was. It saved a password,
// started a sign-up, met a CAPTCHA, and its summary said "signed up" - with an account
// that never existed sitting in the password store. Or the page it kept for the person
// closed, and it gave up. Now:
//
//   - A sign-up's password is hidden from the store until the account is seen working
//     (judgeAccountPage: the app reads the page, the agent's say-so counts for nothing).
//   - A try that can't be shown to have worked is a failed try, and the account is owed
//     again: the agent is woken for it, at any ferocity, until it works.
//   - A failed try's password is kept, hidden, only while it might still be a real
//     account (it was typed into the site): the next try signs in with it first. The
//     site says there's no such account: it's deleted and a new one made.
//   - Only a person ends it: turning the request down cancels the accounts in it.
//   - Not every account has a password (signin.ts): one that signs in by an emailed
//     code, with Google/GitHub/Microsoft..., or through a company's own sign-in is
//     checked the same way - the app reads the signed-in page - only without the
//     "the password went in as typed" part. It joins the store as "signs in with X".
//
// States:
//   needed    nobody is on it (never started, or the last try failed)
//   started   a run is signing up right now
//   waiting   its page is kept for the person (a CAPTCHA, a code)
//   returned  the person finished with its page: the agent finishes and checks it
//   working   seen working - its password is in the store
//   cancelled a person said no

export type AccountState = 'needed' | 'started' | 'waiting' | 'returned' | 'working' | 'cancelled';
export type AccountRow = {
  id: string;
  agent_id: string; // whose account it is
  site: string;
  purpose: string;
  state: AccountState;
  username: string | null;
  browser: number | null;
  password_id: string | null; // this try's password (hidden from the store until working)
  typed_ok: number | null; // the password was read back as typed, this try
  typed_host: string | null; // where it was typed (a sign-up often lives on another host)
  method: string | null; // how it signs in (signin.ts); null: password
  provider: string | null; // sso / company_sso: whose sign-in
  attempts: number; // tries that failed
  last_error: string | null;
  run_id: string | null; // the run signing up now (started)
  request_id: number | null; // the ask its page waits in (waiting)
  setup_request: number | null; // a new agent's setup item (setup.ts)
  next_try_at: number | null;
  created_at: number;
  updated_at: number;
  working_at: number | null;
};

const OPEN_STATES = "('needed', 'started', 'waiting', 'returned')";
const newId = () => `a_${randomBytes(4).toString('hex')}`;
export const accountRow = (id: unknown) => one<AccountRow>('SELECT * FROM accounts WHERE id = ?', String(id ?? '').trim().replace(/^#/, ''));

// "accounts.shop.example.co.uk" -> "example.co.uk": a sign-up, its sign-in and the
// account's own pages are often on different hosts of one site.
const TWO_PART = /^(co|com|org|net|gov|edu|ac)$/;
export function baseDomain(host: string): string {
  const parts = String(host ?? '').toLowerCase().replace(/\.$/, '').split('.').filter(Boolean);
  if (parts.length <= 2) return parts.join('.');
  const n = parts[parts.length - 1].length === 2 && TWO_PART.test(parts[parts.length - 2]) ? 3 : 2;
  return parts.slice(-n).join('.');
}
const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
};

// Who works on an account: its agent - or, while that agent is still in setup (stopped,
// waiting for its person's Start), the Agency Engineer, which makes a new agent's
// accounts as it builds its connectors.
export function workerOf(agentId: string): string {
  if (agentId === FLEET_ENGINEER) return FLEET_ENGINEER;
  return one("SELECT 1 FROM agent_state WHERE agent_id = ? AND setup = 1 AND state = 'stopped'", agentId) ? FLEET_ENGINEER : agentId;
}
// May this agent work on it: it's the one who should, or it's the Agency Engineer.
export const canWork = (row: AccountRow, agentId: string) => agentId === FLEET_ENGINEER || row.agent_id === agentId;

// Written down as needed: once per site and purpose for an agent (asked for again, it's
// the same account - a cancelled one is owed again only when asked for anew).
export function needAccounts(agentId: string, list: { site: string; purpose: string; signIn?: SignIn }[], now: number, setupRequest: number | null = null): AccountRow[] {
  const out: AccountRow[] = [];
  for (const a of list) {
    const site = siteOf(a.site);
    const purpose = String(a.purpose ?? '').trim().slice(0, 200) || 'An account for my job';
    const had = one<AccountRow>("SELECT * FROM accounts WHERE agent_id = ? AND site = ? AND LOWER(purpose) = LOWER(?) AND state != 'cancelled'", agentId, site, purpose);
    if (had) {
      if (setupRequest != null && had.setup_request == null) exec('UPDATE accounts SET setup_request = ? WHERE id = ?', setupRequest, had.id);
      if (a.signIn && had.state !== 'working') exec('UPDATE accounts SET method = ?, provider = ? WHERE id = ?', a.signIn.method === 'password' ? null : a.signIn.method, a.signIn.provider, had.id);
      out.push(accountRow(had.id)!);
      continue;
    }
    const id = newId();
    exec(
      "INSERT INTO accounts (id, agent_id, site, purpose, state, attempts, setup_request, next_try_at, created_at, updated_at, method, provider) VALUES (?, ?, ?, ?, 'needed', 0, ?, ?, ?, ?, ?, ?)",
      id,
      agentId,
      site,
      purpose,
      setupRequest,
      now,
      now,
      now,
      a.signIn && a.signIn.method !== 'password' ? a.signIn.method : null,
      a.signIn?.provider ?? null,
    );
    out.push(accountRow(id)!);
  }
  return out;
}

// Everything an agent works on that isn't settled, oldest first: its own, or (the
// Agency Engineer) those of agents still in setup.
export function accountsOwed(workerId: string): AccountRow[] {
  const rows = all<AccountRow>(`SELECT * FROM accounts WHERE state IN ${OPEN_STATES} ORDER BY created_at, id`);
  return rows.filter(r => workerOf(r.agent_id) === workerId);
}
export const accountsOf = (agentId: string) => all<AccountRow>('SELECT * FROM accounts WHERE agent_id = ? ORDER BY created_at, id', agentId);

// How long before a failed account is tried again: straight away the first time, then
// further apart - a site that blocked a sign-up rarely lets the next one through a
// minute later - but never longer than a day, and never given up on.
export const RETRY_MS = [0, 10 * 60_000, 40 * 60_000, 3 * 3_600_000, 12 * 3_600_000, 24 * 3_600_000];
export const retryIn = (attempts: number) => RETRY_MS[Math.min(Math.max(0, attempts), RETRY_MS.length - 1)];

// A try begins. An earlier try whose password did go into the site may have made the
// account without anyone seeing it: that password is kept and the agent signs in with
// it first (reuse). Otherwise - nothing typed, or the agent saw the site say there's no
// such account (fresh) - the old one is deleted and a new one made.
//
// signIn: how it signs in (left out: as it was written down, else a password). An
// account with no password still gets its store entry now - hidden, with nothing in
// the vault - so it counts toward its browser's accounts on that site like any other.
// Changing how it signs in throws away the earlier try's password (dropped: the site
// was seen to have none).
export async function startAttempt(id: string, p: { username: string; browser: number; runId: string; fresh?: boolean; signIn?: SignIn; now: number }): Promise<{ row: AccountRow; passwordId: string; reuse: boolean; dropped: boolean }> {
  const row = accountRow(id);
  if (!row) throw new Error(`No account ${id}. signed_in_browser.accounts lists yours.`);
  if (row.state === 'working') throw new Error(`${row.id} (${row.username} at ${row.site}) is already working: sign in with it (signed_in_browser.passwords has its password number).`);
  if (row.state === 'cancelled') throw new Error(`${row.id} was cancelled by a person. Don't make it.`);
  const username = p.username.trim();
  if (!username) throw new Error('Give the username or email address the account will use.');
  const was = signInOf(row);
  const how = p.signIn ?? was;
  const withPassword = how.method === 'password';
  const old = row.password_id ? passwordRow(row.password_id) : undefined;
  const sameWay = how.method === was.method && how.provider === was.provider;
  const reuse = withPassword && sameWay && !!old && !!row.typed_ok && !p.fresh && (row.username ?? '').toLowerCase() === username.toLowerCase();
  const dropped = !sameWay && was.method === 'password' && !!old && !!row.typed_ok;
  let passwordId = old?.id ?? '';
  if (!reuse) {
    if (old) await deletePassword(old.id);
    passwordId = await savePassword({ site: row.site, username, password: withPassword ? makePassword() : null, signIn: how, profile: p.browser, agentId: row.agent_id, note: row.purpose, accountId: row.id });
  }
  exec('UPDATE accounts SET method = ?, provider = ? WHERE id = ?', withPassword ? null : how.method, how.provider, row.id);
  exec(
    "UPDATE accounts SET state = 'started', username = ?, browser = ?, password_id = ?, typed_ok = ?, typed_host = ?, run_id = ?, request_id = NULL, updated_at = ? WHERE id = ?",
    username,
    reuse ? (old!.profile ?? p.browser) : p.browser,
    passwordId,
    reuse ? 1 : null,
    reuse ? row.typed_host : null,
    p.runId,
    p.now,
    row.id,
  );
  return { row: accountRow(row.id)!, passwordId, reuse, dropped };
}

// A store password was typed into a page: whether the field kept it, and on which host.
// Only a password read back as typed can ever be confirmed - one the form dropped is
// not the account's password, whatever the page says next.
export function passwordTyped(passwordId: string, ok: boolean, url: string, now: number) {
  exec("UPDATE accounts SET typed_ok = ?, typed_host = COALESCE(?, typed_host), updated_at = ? WHERE password_id = ? AND state IN ('started', 'returned', 'needed')", ok ? 1 : 0, hostOf(url) || null, now, passwordId);
}

// Its page is kept for the person. (A working account's sign-in page kept for them - a
// code at sign-in - stays working.)
export function pageKept(id: string, now: number) {
  exec("UPDATE accounts SET state = 'waiting', request_id = NULL, updated_at = ? WHERE id = ? AND state IN ('needed', 'started', 'returned')", now, id);
}
export function askFiled(ids: string[], request: number, now: number) {
  for (const id of ids) exec("UPDATE accounts SET request_id = ?, updated_at = ? WHERE id = ? AND state = 'waiting'", request, now, id);
}
// The person finished with its page (Done, or they closed the tab): the agent's again,
// to finish the sign-up and have it checked.
// tellNow: nobody is telling its agent (no request was answered): the next tick wakes it.
// Otherwise the request's answer does, and it's left alone for a while after.
export function personFinished(id: string, now: number, tellNow = false) {
  exec("UPDATE accounts SET state = 'returned', next_try_at = ?, updated_at = ? WHERE id = ? AND state = 'waiting'", tellNow ? now : now + NUDGE_MS, now, id);
}

// A try that can't be shown to have worked. The account is owed again. Its password
// stays (hidden) only if it reached the site, where it may be a real account's.
export async function attemptFailed(id: string, why: string, now: number): Promise<AccountRow | null> {
  const row = accountRow(id);
  if (!row || !['started', 'waiting', 'returned'].includes(row.state)) return null;
  const attempts = row.attempts + 1;
  const keep = !!row.typed_ok && !!row.password_id;
  if (!keep && row.password_id) await deletePassword(row.password_id);
  exec(
    "UPDATE accounts SET state = 'needed', attempts = ?, last_error = ?, password_id = ?, typed_ok = ?, run_id = NULL, request_id = NULL, next_try_at = ?, updated_at = ? WHERE id = ?",
    attempts,
    why.slice(0, 400),
    keep ? row.password_id : null,
    keep ? 1 : null,
    now + retryIn(attempts),
    now,
    row.id,
  );
  return accountRow(row.id)!;
}

// A person said no (they turned its request down, or told the Agency Engineer): it's
// no longer owed, and whatever password a try had is deleted.
export async function cancelAccount(id: string, why: string, now: number): Promise<boolean> {
  const row = accountRow(id);
  if (!row || row.state === 'working' || row.state === 'cancelled') return false;
  if (row.password_id) await deletePassword(row.password_id);
  exec("UPDATE accounts SET state = 'cancelled', last_error = ?, password_id = NULL, typed_ok = NULL, run_id = NULL, request_id = NULL, next_try_at = NULL, updated_at = ? WHERE id = ?", why.slice(0, 400), now, row.id);
  settleSetupRequest(row.setup_request, now);
  return true;
}

// --- Seen working ---------------------------------------------------------------------

// What the app reads off the page an agent says is the signed-in account (browser.ts
// gathers it): its address, how many password boxes show, its text, and what its
// links, buttons and forms say and point at.
export type PageFacts = { url: string; passwordFields: number; text: string; controls: string };
export const PAGE_FACTS_EXPR = `(() => {
  const shown = e => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const passwordFields = [...document.querySelectorAll('input[type=password]')].filter(shown).length;
  const text = (document.body ? document.body.innerText : '').slice(0, 300000);
  const controls = [...document.querySelectorAll('a, button, [role=menuitem], [role=button], form, img[alt], [aria-label]')].slice(0, 4000)
    .map(e => [(e.textContent || '').trim().slice(0, 80), e.getAttribute('aria-label') || '', e.getAttribute('title') || '', e.getAttribute('alt') || '', e.getAttribute('href') || '', e.getAttribute('action') || ''].join(' '))
    .join('\\n').slice(0, 300000);
  return { url: location.href, passwordFields, text, controls };
})()`;

const STILL_SIGNING = /(^|[/_.-])(sign-?up|register|registration|join|create-?account|log-?in|sign-?in|challenge|checkpoint|captcha|verify|verification|confirm-?email)([/_.?#-]|$)/i;
const SIGN_OUT = /\b(log|sign)[\s-]?out\b|logout|signout|sign_out|log_out/i;

// Whether the page shows this account signed in and working: every reason it doesn't,
// in the agent's words. Empty means it does. Deliberately strict, and never the
// agent's own claim: a wrong "working" is an account that doesn't exist in the store.
export function judgeAccountPage(row: Pick<AccountRow, 'site' | 'username' | 'typed_ok' | 'typed_host' | 'password_id'> & Partial<Pick<AccountRow, 'method' | 'provider'>>, page: PageFacts): string[] {
  const problems: string[] = [];
  if (!row.password_id || !row.username) return ["No sign-up has been started for it: signed_in_browser.start_sign_up first."];
  const how = signInOf(row);
  // Only a password account has a password to have gone in: the rest are judged by the page alone.
  if (how.method === 'password' && !row.typed_ok)
    problems.push("Its password never went into the site as typed (signed_in_browser.type_password hasn't put it in a password field that kept it), so whatever account the site may have made doesn't have the store's password. Type it with type_password on the sign-up form (both boxes, if it asks twice) and submit again - or start_sign_up again with new_password true.");
  const host = hostOf(page.url);
  const sites = new Set([baseDomain(row.site), row.typed_host ? baseDomain(row.typed_host) : ''].filter(Boolean));
  const idp = host ? providerPage(host, baseDomain(row.site)) : null;
  if (!host || !sites.has(baseDomain(host)))
    problems.push(
      idp
        ? `This page is ${idp}'s sign-in (${host}), not ${row.site}: the sign-in isn't finished. Finish it there (pick the account, allow access - or show_person with the account_id if it needs a password, an authenticator or a phone you don't have); it sends you back to ${row.site}. Then open the account's profile or settings page there and check again.`
        : `This page (${host || 'no address'}) isn't on ${row.site}. Open the account's own page there - its profile, settings or home page - and check again.`,
    );
  if (page.passwordFields > 0) problems.push('This page still shows a password box, so it is a sign-up or sign-in form, not the account signed in. If the form is still waiting to be sent, finish it; otherwise open the account\'s profile or settings page and check again.');
  let path = '';
  try {
    path = new URL(page.url).pathname;
  } catch {
    // no address: said above
  }
  const step = how.method === 'email_code' ? `the code or link emailed to ${row.username}` : how.method === 'password' ? 'a code from the inbox, a link to press' : `the ${providerName(how.provider)} sign-in, then anything ${row.site} still asks`;
  if (STILL_SIGNING.test(path)) problems.push(`This address (${path.slice(0, 80)}) is still part of signing up, signing in or a verification step. Finish that step (${step}), then open the account's profile or settings page and check again.`);
  // The email address in full, or a username as a word of its own ("@northside", not
  // the "sales" in "salesforce"): the start of an email address is too often a plain word.
  const name = row.username.toLowerCase();
  const hay = `${page.text}\n${page.controls}`.toLowerCase();
  const asWord = new RegExp(`(^|[^a-z0-9_.-])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9_-]|$)`);
  const shows = name.includes('@') ? hay.includes(name) : name.length >= 3 && asWord.test(hay);
  if (!shows && !SIGN_OUT.test(page.controls))
    problems.push(`Nothing on this page shows ${row.username} signed in: not the username or email, and no sign-out link. Open the page where the account shows who is signed in (its profile, or account settings) and check again. If the site isn't signed in at all, the sign-up didn't go through.`);
  return problems;
}

// Seen working: its password joins the store, and a new agent's setup item is ticked
// once every account it stands for works.
export function markWorking(id: string, now: number): AccountRow {
  const row = accountRow(id);
  if (!row) throw new Error(`No account ${id}.`);
  if (row.password_id) exec('UPDATE passwords SET confirmed_at = ?, username = COALESCE(?, username) WHERE id = ?', now, row.username, row.password_id);
  exec("UPDATE accounts SET state = 'working', working_at = ?, last_error = NULL, run_id = NULL, request_id = NULL, next_try_at = NULL, updated_at = ? WHERE id = ?", now, now, row.id);
  settleSetupRequest(row.setup_request, now);
  return accountRow(row.id)!;
}

// A new agent's "X account" setup item: done once none of its accounts is still owed
// (each works, or a person cancelled it) and at least one works.
function settleSetupRequest(request: number | null, now: number) {
  if (request == null) return;
  const rows = all<AccountRow>('SELECT * FROM accounts WHERE setup_request = ?', request);
  if (!rows.length || rows.some(r => r.state !== 'working' && r.state !== 'cancelled')) return;
  const made = rows.filter(r => r.state === 'working');
  if (!made.length) return;
  exec(
    "UPDATE requests SET status = 'done', answer = ?, answered_at = ?, stage = NULL WHERE id = ? AND status = 'open'",
    `Made and seen working: ${made.map(r => `${r.username} at ${r.site}${r.method ? ` (signs in with ${signInWords(signInOf(r))})` : ''}`).join(', ')}. ${made.length === 1 ? 'It is' : 'They are'} in the password store (signed_in_browser.passwords).`,
    now,
    request,
  );
}

// --- For the run's instructions ----------------------------------------------------------

const STATE_WORDS: Record<AccountState, string> = {
  needed: 'to make',
  started: 'being signed up',
  waiting: 'its page is waiting on the person',
  returned: 'the person finished with its page - finish the sign-up there and check it',
  working: 'working',
  cancelled: 'cancelled by a person',
};
export function accountLine(r: AccountRow, withAgent = false): string {
  const tried = r.attempts ? ` - ${r.attempts} ${r.attempts === 1 ? 'try' : 'tries'} failed, last: ${r.last_error ?? 'no reason recorded'}` : '';
  const had = r.state === 'needed' && r.password_id ? ` An earlier try may have made it as ${r.username}: start_sign_up with that username signs in with it first.` : '';
  const how = r.method ? `signs in with ${signInWords(signInOf(r))}` : '';
  const who = [r.username, how].filter(Boolean).join(', ');
  return `- ${r.id} ${r.site}${withAgent ? ` for ${r.agent_id}` : ''}: ${r.purpose}${who ? ` (${who})` : ''} - ${STATE_WORDS[r.state]}${tried}.${had}`;
}

// The accounts section of a run's instructions: the app's own record, so an agent can
// neither forget one it owes nor believe one it only thinks it made.
export function accountsForPrompt(workerId: string): string {
  const owed = accountsOwed(workerId);
  if (!owed.length) return '';
  const forOthers = owed.some(r => r.agent_id !== workerId);
  return `## Accounts you owe
The app's own record - it, not your memory or an earlier summary, says what exists. Each stays here until the app has seen it working (signed_in_browser.check_account) or a person cancels it. An account not marked working does not exist: never say it does.
${owed.map(r => accountLine(r, forOthers)).join('\n')}
Work through all of them in one go: start_sign_up (with sign_in: how the site signs in - a password, a code emailed to it, "Sign in with Google/GitHub/Microsoft...", or a company's own sign-in), fill the form, type_password if it has one, submit; at a check only a person can do, show_person with its account_id and go straight on to the next account. When every one is working or waiting on the person, call signed_in_browser.wait_for_person once: it hands the person all the waiting pages in ONE request and waits for them.`;
}

// --- Keeping at it (scheduler.ts) ---------------------------------------------------------

// Accounts due another go, by who works on them: owed, nobody on them, and their wait
// since the last failed try is over. Each is then left alone for a while (NUDGE_MS) so a
// run that didn't get to it isn't woken every tick - but it is woken again.
export const NUDGE_MS = 6 * 3_600_000;
export function accountsDue(now: number): Map<string, AccountRow[]> {
  const due = all<AccountRow>("SELECT * FROM accounts WHERE state IN ('needed', 'returned') AND (next_try_at IS NULL OR next_try_at <= ?) ORDER BY created_at, id", now);
  const by = new Map<string, AccountRow[]>();
  for (const r of due) {
    const w = workerOf(r.agent_id);
    by.set(w, [...(by.get(w) ?? []), r]);
  }
  return by;
}
export function nudged(rows: AccountRow[], now: number) {
  for (const r of rows) exec('UPDATE accounts SET next_try_at = ? WHERE id = ?', now + NUDGE_MS, r.id);
}
export function dueText(rows: AccountRow[], workerId: string): string {
  const back = rows.filter(r => r.state === 'returned');
  const forOthers = rows.some(r => r.agent_id !== workerId);
  return [
    `${rows.length === 1 ? 'An account you owe is' : `${rows.length} accounts you owe are`} still not working, so ${rows.length === 1 ? 'it is' : 'they are'} yours to finish now:`,
    ...rows.map(r => accountLine(r, forOthers)),
    back.length ? "Where the person finished with a page, it's in your tabs (signed_in_browser.tabs list): switch to it, finish the sign-up there, then signed_in_browser.check_account." : '',
    'Do every one of them this run. One that needs the person again: show_person with its account_id, on to the next, and wait_for_person once at the end.',
  ]
    .filter(Boolean)
    .join('\n');
}

// --- A person waited for inside a run (signed_in_browser.wait_for_person) -------------------

// Requests a run is waiting on right now: when one is answered, that run carries on by
// itself, so its agent isn't woken a second time for the same news.
const waitedOn = new Map<number, number>();
export const waitingInRun = (request: number) => (waitedOn.get(request) ?? 0) > 0;
export function holdForRun(request: number): () => void {
  waitedOn.set(request, (waitedOn.get(request) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const n = (waitedOn.get(request) ?? 1) - 1;
    if (n > 0) waitedOn.set(request, n);
    else waitedOn.delete(request);
  };
}

// The accounts whose pages a request holds, or held.
export const accountsInAsk = (request: number) => all<AccountRow>('SELECT * FROM accounts WHERE request_id = ? ORDER BY created_at, id', request);
// Whether a request is (or was) the one ask for accounts' pages: api.ts leaves waking
// its agent to askSettled, below.
export const isAccountAsk = (request: number) => !!one("SELECT 1 FROM requests WHERE id = ? AND service = 'accounts'", request);
