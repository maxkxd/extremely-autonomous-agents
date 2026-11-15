import '../test-data-dir.js';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { browserExe, pageViewForTests as view } from './browser.js';
import { Cdp, CdpPage, dateValue, looseText } from './cdp.js';

// Fields that won't take typed-in text, against a real browser. Request #378: on
// Pinterest's business sign-up the agent filled email and password, but "the
// birthdate box won't take typing from the agent's browser", so a person was asked
// to type a date. A date field takes no typed-in text at all; a masked MM/DD/YYYY box
// may build its value from keydowns alone; a React form keeps its own copy of the
// value and puts it back over one set the plain way. The agent's type fills each,
// and reads it back.

const exe = browserExe();
let proc: ChildProcess | undefined;
let cdp: Cdp;
let dir: string;

before(async () => {
  if (!exe) return;
  dir = await mkdtemp(join(tmpdir(), 'eaa-fill-test-'));
  proc = spawn(exe, [`--user-data-dir=${dir}`, '--headless=new', '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check', '--lang=en-US', ...(process.platform === 'linux' ? ['--no-sandbox'] : []), 'about:blank'], { stdio: 'ignore' });
  let found = '';
  for (let i = 0; i < 150 && !found.includes('/devtools/'); i++) {
    found = await readFile(join(dir, 'DevToolsActivePort'), 'utf8').catch(() => '');
    await new Promise(r => setTimeout(r, 100));
  }
  const [port, path] = found.replace(/\r/g, '').split('\n');
  cdp = await Cdp.connect(`ws://127.0.0.1:${port}${path}`);
});
after(async () => {
  if (!proc) return;
  await cdp.send('Browser.close').catch(() => {});
  await new Promise(r => setTimeout(r, 500));
  proc.kill();
  await rm(dir, { recursive: true, force: true }).catch(() => {});
});

const skip = !exe && 'no Edge or Chrome on this machine';
const refOf = (snap: string, kind: string, label: string) => {
  const m = new RegExp(`\\[(\\d+)\\] ${kind.replace(/[()]/g, '\\$&')} "${label.replace(/[()/]/g, '\\$&')}"`).exec(snap);
  assert.ok(m, `no ${kind} "${label}" in:\n${snap}`);
  return Number(m[1]);
};

// The sign-up form, as such forms are built. window.got is what the page itself
// holds for each field (its framework's state), not just what the box shows.
const SIGN_UP = `<!doctype html><html lang="en-US"><body><form onsubmit="return false">
<p><label>Birthdate <input type="date" id="bd"></label></p>
<p><label>Date of birth (MM/DD/YYYY) <input id="mask" placeholder="MM/DD/YYYY" inputmode="numeric"></label></p>
<p><label>Phone <input id="phone" type="tel"></label></p>
<p><label>Business name <input id="react"></label></p>
<p><label>Website <input id="locked"></label></p>
<p><label>Referral code <input id="never"></label></p>
<button>Continue</button>
</form><script>
// Kept on the page too: the agent's scripts run in a world of their own, and only the page is shared.
window.got = new Proxy({}, { set(o, k, v) { o[k] = v; document.body.dataset.got = JSON.stringify(o); return true; } });
bd.addEventListener('input', () => got.bd = bd.value);
bd.addEventListener('change', () => got.bdChange = bd.value);

// A mask that builds the date from keydowns, and takes nothing typed in or pasted.
let digits = '';
const fmt = d => [d.slice(0, 2), d.slice(2, 4), d.slice(4, 8)].filter(Boolean).join('/');
mask.addEventListener('beforeinput', e => e.preventDefault());
mask.addEventListener('keydown', e => {
  if (e.key === 'Backspace') digits = digits.slice(0, -1);
  else if (/^[0-9]$/.test(e.key)) digits = (digits + e.key).slice(0, 8);
  else if (e.key.length !== 1) return;
  e.preventDefault();
  mask.value = fmt(digits);
  got.mask = digits;
});

// A mask that reformats on every input: (555) 010-1234.
phone.addEventListener('input', () => {
  const d = phone.value.replace(/\\D/g, '').slice(0, 10);
  phone.value = d.length > 6 ? '(' + d.slice(0, 3) + ') ' + d.slice(3, 6) + '-' + d.slice(6) : d;
  got.phone = d;
});

// React's controlled input: it keeps its own copy of the value on the element (its
// value tracker), takes a change only when the box differs from that copy, and puts
// its state back after every input event.
const controlled = (el, key) => {
  const own = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  let state = '', tracked = '';
  Object.defineProperty(el, 'value', { configurable: true, get() { return own.get.call(this); }, set(v) { tracked = String(v); own.set.call(this, v); } });
  el.addEventListener('input', () => {
    const v = own.get.call(el);
    if (v !== tracked) { tracked = v; state = v; }
    got[key] = state;
    Promise.resolve().then(() => { el.value = state; });
  });
};
controlled(react, 'react');
// One that's controlled and takes no typing or keys at all (a custom widget's own
// handlers): only the value set directly, with its input event, gets in.
controlled(locked, 'locked');
locked.addEventListener('beforeinput', e => e.preventDefault());
locked.addEventListener('keydown', e => { if (e.key.length === 1 || e.key === 'Backspace') e.preventDefault(); });

// One that throws away anything: there's nothing to be done, and fill says so.
never.addEventListener('input', () => { never.value = ''; });
</script></body></html>`;

const open = async () => {
  const p = await CdpPage.open(cdp, { left: 0, top: 0, width: 1200, height: 900 });
  await p.goto(`data:text/html;charset=utf-8,${encodeURIComponent(SIGN_UP)}`);
  const snap = await view.snapshot(p);
  return { p, snap, got: () => p.evaluate<string | undefined>('document.body.dataset.got').then(s => JSON.parse(s ?? '{}') as Record<string, string>) };
};

test('a date field (the birthdate, request #378) takes the date as the agent writes it, and the page sees it', { skip }, async () => {
  const { p, snap, got } = await open();
  const bd = refOf(snap, 'date field', 'Birthdate');
  for (const [typed, want] of [['01/15/1990', '1990-01-15'], ['1990-01-15', '1990-01-15'], ['15 January 1990', '1990-01-15'], ['March 3, 1988', '1988-03-03'], ['31/12/1985', '1985-12-31']]) {
    const r = await p.fill(bd, typed);
    assert.deepEqual(r, { ok: true, value: want }, typed);
    const g = await got();
    assert.equal(g.bd, want, `the page's input event for ${typed}`);
    assert.equal(g.bdChange, want, `the page's change event for ${typed}`);
  }
  assert.match(await view.snapshot(p), new RegExp(`\\[${bd}\\] date field "Birthdate" = "1985-12-31"`));
  await assert.rejects(p.fill(bd, 'next Tuesday'), /date field, and "next Tuesday" doesn't read as one/);
  await p.close();
});

test('a masked MM/DD/YYYY box that only listens to keys gets the date key by key', { skip }, async () => {
  const { p, snap, got } = await open();
  const mask = refOf(snap, 'text field', 'MM/DD/YYYY');
  const r = await p.fill(mask, '01/15/1990');
  assert.deepEqual(r, { ok: true, value: '01/15/1990' });
  assert.equal((await got()).mask, '01151990');
  // Again, over what's there: cleared first, not added to.
  assert.deepEqual(await p.fill(mask, '02/28/1991'), { ok: true, value: '02/28/1991' });
  assert.equal((await got()).mask, '02281991');
  await p.close();
});

test('a phone mask that reformats what is typed counts as filled', { skip }, async () => {
  const { p, snap, got } = await open();
  const phone = refOf(snap, 'tel field', 'Phone');
  assert.deepEqual(await p.fill(phone, '555-010-1234'), { ok: true, value: '(555) 010-1234' });
  assert.equal((await got()).phone, '5550101234');
  await p.close();
});

test("a React-controlled field keeps what's typed in its own state - typed, or set directly when it takes no typing", { skip }, async () => {
  const { p, snap, got } = await open();
  const react = refOf(snap, 'text field', 'Business name');
  assert.deepEqual(await p.fill(react, 'Example Studio'), { ok: true, value: 'Example Studio' });
  const locked = refOf(snap, 'text field', 'Website');
  assert.deepEqual(await p.fill(locked, 'https://example.com'), { ok: true, value: 'https://example.com' });
  await new Promise(r => setTimeout(r, 100)); // past its redraw
  const g = await got();
  assert.equal(g.react, 'Example Studio');
  assert.equal(g.locked, 'https://example.com', "the framework's state, not just the box");
  assert.equal(await p.evaluate(`document.getElementById('locked').value`), 'https://example.com', 'still there after the redraw');
  await p.close();
});

test("a field that throws away whatever's put in says so, with what it holds", { skip }, async () => {
  const { p, snap } = await open();
  const never = refOf(snap, 'text field', 'Referral code');
  assert.deepEqual(await p.fill(never, 'FRIEND10'), { ok: false, value: '' });
  await p.close();
});

test('dates as an agent writes them, for each kind of date field', () => {
  assert.equal(dateValue('date', '01/15/1990'), '1990-01-15');
  assert.equal(dateValue('date', '1/5/1990'), '1990-01-05');
  assert.equal(dateValue('date', '05/01/1990', 'dmy'), '1990-01-05');
  assert.equal(dateValue('date', '15.01.1990'), '1990-01-15');
  assert.equal(dateValue('date', 'Jan 15th, 1990'), '1990-01-15');
  assert.equal(dateValue('date', '01151990'), '1990-01-15');
  assert.equal(dateValue('date', '19900115'), '1990-01-15');
  assert.equal(dateValue('date', '02/30/1990'), null, 'no such day');
  assert.equal(dateValue('date', 'soon'), null);
  assert.equal(dateValue('month', 'January 1990'), '1990-01');
  assert.equal(dateValue('month', '01/1990'), '1990-01');
  assert.equal(dateValue('time', '9:30 pm'), '21:30');
  assert.equal(dateValue('time', '12:05 am'), '00:05');
  assert.equal(dateValue('datetime-local', '1990-01-15 09:30'), '1990-01-15T09:30');
  assert.equal(dateValue('datetime-local', '01/15/1990'), '1990-01-15T00:00');
  assert.equal(dateValue('week', '1990-w3'), '1990-W03');
  assert.equal(looseText('(555) 010-1234'), looseText('555-010-1234'));
});
