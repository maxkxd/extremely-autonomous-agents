import '../test-data-dir.js';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { browserExe, inPage, pageViewForTests as view } from './browser.js';
import { Cdp, CdpPage } from './cdp.js';

// The page view against a real browser, on pages built to fail the way directory
// forms did (the app gaps the Agency Engineer and the Doctor reported): a form that
// draws its fields again as you type, a long form whose Submit was past the first
// 80 controls, typed values nobody could see, a dropdown made of page elements, a
// page that draws itself after it loads, and a logo upload behind a styled button.

const exe = browserExe();
let proc: ChildProcess | undefined;
let cdp: Cdp;
let dir: string;

before(async () => {
  if (!exe) return;
  dir = await mkdtemp(join(tmpdir(), 'eaa-page-test-'));
  proc = spawn(exe, [`--user-data-dir=${dir}`, '--headless=new', '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check', ...(process.platform === 'linux' ? ['--no-sandbox'] : []), 'about:blank'], { stdio: 'ignore' });
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

const page = async (html: string) => {
  const p = await CdpPage.open(cdp, { left: 0, top: 0, width: 1200, height: 800 });
  await p.goto(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  return p;
};
const refOf = (snap: string, kind: string, label: string) => {
  const m = new RegExp(`\\[(\\d+)\\] ${kind.replace(/[()]/g, '\\$&')} "${label}"`).exec(snap);
  assert.ok(m, `no ${kind} "${label}" in:\n${snap}`);
  return Number(m[1]);
};
const skip = !exe && 'no Edge or Chrome on this machine';

test('a field the form drew again keeps its number, and what was typed shows', { skip }, async () => {
  // Typing in Name redraws the whole form (as React forms often do): Website is a new element.
  const p = await page(`<form id=f></form><script>
    const draw = name => { f.innerHTML = '<label>Name <input id=n value="' + name + '"></label><label>Website <input name=site></label>'; n.oninput = e => draw(e.target.value); n.focus(); };
    draw('');</script>`);
  const s1 = await view.snapshot(p);
  const name = refOf(s1, 'text field', 'Name');
  const site = refOf(s1, 'text field', 'Website');
  await p.fill(name, 'Extremely Autonomous Agents');
  await p.fill(site, 'https://extremely.agency'); // the old number, on the redrawn field
  const s2 = await view.snapshot(p);
  assert.match(s2, new RegExp(`\\[${site}\\] text field "Website" = "https://extremely.agency"`));
  await p.close();
});

test('a long form: the controls nearest the screen are listed, and Submit is reached by scrolling', { skip }, async () => {
  const fields = Array.from({ length: 150 }, (_, i) => `<p><label>Field ${i + 1} <input></label></p>`).join('');
  const p = await page(`${fields}<button>Submit listing</button>`);
  const top = await view.snapshot(p);
  assert.match(top, /more further down the page: scroll down to see them/);
  assert.doesNotMatch(top, /button "Submit listing"/);
  await p.evaluate('window.scrollTo(0, document.body.scrollHeight)');
  const bottom = await view.snapshot(p);
  const submit = refOf(bottom, 'button', 'Submit listing');
  assert.match(bottom, /more further up the page/);
  await p.click(submit);
  await p.close();
});

test('a dropdown made of page elements: choose opens it and clicks the option', { skip }, async () => {
  const p = await page(`<button aria-haspopup=listbox id=b>Category</button><ul role=listbox id=l hidden>
      <li role=option>Text &amp; Writing</li><li role=option>AI Agents</li><li role=option>Productivity</li></ul>
    <script>b.onclick = () => (l.hidden = false); l.onclick = e => { b.textContent = e.target.textContent; l.hidden = true; };</script>`);
  const s = await view.snapshot(p);
  const ref = refOf(s, 'dropdown (opens a list: choose picks from it)', 'Category');
  const after = await view.choose(p, ref, 'AI Agents');
  assert.match(after, /dropdown \(opens a list: choose picks from it\) "AI Agents"/);
  await assert.rejects(view.choose(p, ref, 'Gardening'), /No option like "Gardening".*"Productivity"/);
  await p.close();
});

test("a page that draws itself after loading is read once it has", { skip }, async () => {
  const p = await page(`<div id=app>Loading...</div><script>setTimeout(() => (app.innerHTML = '<h1>Submit your tool</h1><button>Continue</button>'), 700);</script>`);
  await view.settle(p, 5_000, 1_500); // as Open does
  const s = await view.snapshot(p);
  assert.match(s, /Submit your tool/);
  refOf(s, 'button', 'Continue');
  await p.close();
});

test('a logo goes into the hidden file input behind its button', { skip }, async () => {
  const p = await page(`<label id=up style="display:inline-block;padding:8px;border:1px solid">Upload logo<input type=file accept=image/* hidden></label>`);
  const s = await view.snapshot(p);
  const button = refOf(s, 'file upload', 'Upload logo');
  const file = join(dir, 'logo.svg');
  await writeFile(file, '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/>');
  assert.equal(await p.setFiles(inPage(`fileInput(${button})`), [file]), true);
  assert.equal(await p.evaluate("document.querySelector('input[type=file]').files[0].name"), 'logo.svg');
  assert.match(await view.snapshot(p), new RegExp(`\\[${button}\\] file upload "Upload logo" = "logo.svg"`));
  assert.equal(await p.setFiles(inPage('fileInput(9999)'), [file]), false);
  await p.close();
});

test('a click lands on a page that scrolls smoothly (aiagentsdirectory.com, 2026-11-09)', { skip }, async () => {
  // Radio buttons far down a page with scroll-behavior: smooth: measured mid-scroll,
  // every click missed and the agent handed the form to a person.
  const p = await page(`<style>html{scroll-behavior:smooth}</style><div style="height:2500px">Top</div>
    <label><input type=radio name=access value="Open Source"><span>Open Source</span></label>
    <label><input type=checkbox name=category value="AI Agents Platform"><span>AI Agents Platform</span></label><div style="height:1500px"></div>`);
  const s = await view.snapshot(p);
  await p.click(refOf(s, 'radio option', 'Open Source'));
  await p.click(refOf(s, 'checkbox', 'AI Agents Platform'));
  assert.equal(await p.evaluate("document.querySelector('input[name=access]').checked"), true);
  assert.equal(await p.evaluate("document.querySelector('input[name=category]').checked"), true);
  await p.close();
});

test('a click on a control under a pop-up says so, instead of landing on the pop-up', { skip }, async () => {
  // aiagentsdirectory.com opens "Add Your Product" over its form a moment after loading.
  const p = await page(`<label><input type=radio name=access value="Open Source"><span>Open Source</span></label>
    <div id=pop style="position:fixed;inset:0;background:#0009"><div style="background:#fff;margin:40px;padding:20px"><div>Add Your Product</div><button onclick="pop.remove()">✕</button></div></div>`);
  const s = await view.snapshot(p);
  const box = refOf(s, 'radio option', 'Open Source');
  await assert.rejects(p.click(box), /Something is on top of \[\d+\], so the click would land on it instead: "Add Your Product ✕"/); // its lines run together
  assert.equal(await p.evaluate("document.querySelector('input').checked"), false);
  await p.click(refOf(await view.snapshot(p), 'button', '✕'));
  await p.click(box);
  assert.equal(await p.evaluate("document.querySelector('input').checked"), true);
  await p.close();
});

test("a styled dropdown's own face isn't a pop-up in the way, but another control's menu is", { skip }, async () => {
  // Bowora's "Select...": the words sit on top of the numbered input, and clicking them opens the list.
  const p = await page(`<div onmousedown="out.textContent='opened'" style="position:relative;width:300px;height:38px;border:1px solid">
      <div style="position:absolute;inset:0;padding:8px;z-index:1">Select...</div>
      <input role=combobox aria-label=Team style="position:absolute;left:140px;top:9px;width:20px;height:20px;border:0;background:none"></div>
    <div style="position:relative;width:300px;height:38px;margin-top:20px"><button type=button onclick="out2.textContent='opened'" style="position:absolute;inset:0;z-index:1">Choose</button>
      <select aria-label=Stage style="position:absolute;left:100px;top:9px;width:60px;height:20px"><option>One</select></div>
    <p id=out></p><p id=out2></p>
    <div style="position:relative;height:40px;margin-top:20px"><input aria-label=First style="position:absolute;left:0;top:0;width:200px"><input aria-label=Second style="position:absolute;left:220px;top:0;width:200px">
      <div style="position:absolute;left:0;top:0;width:420px;height:30px;background:#fff;z-index:2">Menu item</div></div>`);
  const s = await view.snapshot(p);
  await p.click(refOf(s, 'dropdown (opens a list: choose picks from it)', 'Team'));
  assert.equal(await p.evaluate('out.textContent'), 'opened');
  await p.click(refOf(s, 'dropdown', 'Stage'));
  assert.equal(await p.evaluate('out2.textContent'), 'opened');
  await assert.rejects(p.click(refOf(s, 'text field', 'First')), /Something is on top of \[\d+\].*"Menu item"/);
  await p.close();
});

test("a pop-up's icon-only close button is named, and listed when it's in the way", { skip }, async () => {
  // aiagentsdirectory.com's newsletter pop-up: its only way out is an SVG X with no text.
  const p = await page(`<label><input type=checkbox name=category value="AI Agents Platform"><span>AI Agents Platform</span></label>
    <div id=pop style="position:fixed;inset:0;background:#0009"><div style="background:#fff;margin:40px;padding:20px">
      <button onclick="pop.remove()"><svg width=20 height=20 viewBox="0 0 24 24"><path d="M6 18L18 6M6 6l12 12" stroke="#000"/></svg></button>
      <p>EXCLUSIVE ACCESS Agent Pulse Newsletter</p><button>Subscribe Free</button></div></div>`);
  const box = refOf(await view.snapshot(p), 'checkbox', 'AI Agents Platform');
  const err = await p.click(box).then(() => null, (e: Error) => e.message);
  assert.match(err ?? '', /EXCLUSIVE ACCESS/);
  const close = /\[(\d+)\] button "close \(x icon\)"/.exec(err ?? '');
  assert.ok(close, `no close button listed in: ${err}`);
  assert.match(err ?? '', /button "Subscribe Free"/);
  await p.click(Number(close[1]));
  await p.click(box);
  assert.equal(await p.evaluate("document.querySelector('input').checked"), true);
  await p.close();
});

test('a Copy button: the click says what was copied, however the page copies it', { skip }, async () => {
  // Tulimoa gives its badge code only through a Copy button. The clipboard API exists
  // only on a secure page, so this one is served from localhost.
  const html = `<button onclick="navigator.clipboard.writeText('<a href=x>badge</a>').then(() => (out.textContent = 'Copied!'), () => (out.textContent = 'Copy failed'))">Copy API</button>
    <button onclick="const t = document.createElement('textarea'); t.value = 'from a textarea'; document.body.append(t); t.select(); document.execCommand('copy'); t.remove()">Copy old</button>
    <button onclick="document.addEventListener('copy', e => { e.clipboardData.setData('text/plain', 'set in the event'); e.preventDefault(); }, { once: true }); document.execCommand('copy')">Copy event</button>
    <button>Plain</button><p id=out></p>`;
  const server = createServer((_, res) => res.setHeader('content-type', 'text/html').end(html));
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const p = await CdpPage.open(cdp, { left: 0, top: 0, width: 1200, height: 800 });
  await p.goto(`http://localhost:${(server.address() as AddressInfo).port}/`);
  const s = await view.snapshot(p);
  const after = await view.click(p, refOf(s, 'button', 'Copy API'));
  assert.ok(after.startsWith('That click copied this to the clipboard:\n<a href=x>badge</a>\n'), after);
  assert.match(after, /Copied!/); // the page is told it worked
  assert.match(await view.click(p, refOf(s, 'button', 'Copy old')), /^That click copied this to the clipboard:\nfrom a textarea\n/);
  assert.match(await view.click(p, refOf(s, 'button', 'Copy event')), /^That click copied this to the clipboard:\nset in the event\n/);
  // Told once, and not for a click that copied nothing.
  assert.doesNotMatch(await view.click(p, refOf(s, 'button', 'Plain')), /copied this/);
  await p.close();
  server.close();
});

// Pages on localhost; a frame on 127.0.0.1 is another site, so another process.
const serve = async (pages: Record<string, string>) => {
  const server = createServer((req, res) => res.setHeader('content-type', 'text/html').end(pages[req.url ?? ''] ?? 'none'));
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return { server, port: (server.address() as AddressInfo).port };
};
const open = async (url: string) => {
  const p = await CdpPage.open(cdp, { left: 0, top: 0, width: 1200, height: 800 });
  await p.goto(url);
  return p;
};

test('a window the site opens: the agent goes into it, and is back when it closes', { skip }, async () => {
  const { server, port } = await serve({
    '/': `<button onclick="window.open('/pop', 'signin', 'width=500,height=500')">Sign in</button><a href="/tab" target="_blank">Terms</a><p id=out>signed out</p>`,
    '/pop': `<p>Allow this site?</p><button onclick="opener.document.getElementById('out').textContent = 'signed in'; window.close()">Authorize</button>`,
    '/tab': `<h1>The terms</h1>`,
  });
  const p = await open(`http://localhost:${port}/`);
  const s: { page: CdpPage; cdp: CdpPage; openers?: CdpPage[] } = { page: p, cdp: p };
  const first = await view.snapshot(p);
  const inside = await view.clickIn(s, refOf(first, 'button', 'Sign in'));
  assert.match(inside, /^That click opened a new window/);
  assert.match(inside, /Allow this site\?/);
  assert.notEqual(s.page, p);
  const back = await view.clickIn(s, refOf(inside, 'button', 'Authorize'));
  assert.match(back, /^That window closed/);
  assert.match(back, /signed in/);
  assert.equal(s.page, p);
  // A link to a new tab goes the same way (it has no opener to reach, and still counts).
  const tab = await view.clickIn(s, refOf(back, 'link', 'Terms'));
  assert.match(tab, /The terms/);
  await s.page.close();
  await p.close();
  server.close();
});

test('a frame on the page: another site\'s form is read and used by its numbers', { skip }, async () => {
  view.allowAllFrames();
  const frame = (host: string, path: string, h: number) => `<iframe src="http://${host}${path}" style="width:600px;height:${h}px;border:8px solid;padding:4px"></iframe>`;
  const form = `<p>Embedded form</p><label>Name <input name=who></label>
    <select aria-label=Plan><option>Free<option>Paid</select>
    <button onclick="document.querySelector('p').textContent = 'Sent ' + document.querySelector('input').value + ' ' + document.querySelector('select').value">Send</button>`;
  const { server, port } = await serve({ '/': '', '/form': form, '/inner': `<button onclick="this.textContent='Pressed'">Deep</button>` });
  const pages: Record<string, string> = {};
  const { server: site, port: sitePort } = await serve(pages);
  // Cross-site (another process), far down the page; same-site; and a security check.
  pages['/'] = `<div style="height:1400px">Top of the page</div>${frame(`127.0.0.1:${port}`, '/form', 200)}${frame(`localhost:${sitePort}`, '/same', 120)}${frame(`127.0.0.1:${port}`, '/recaptcha/api2/anchor', 80)}`;
  pages['/same'] = form.replace('Embedded form', 'Same-site form');
  const p = await open(`http://localhost:${sitePort}/`);
  await new Promise(r => setTimeout(r, 800));
  let s = await view.snapshot(p);
  assert.match(s, /In a frame on this page \(127\.0\.0\.1:\d+\):\nEmbedded form/);
  assert.match(s, /security check \(CAPTCHA\)/);
  const inFrame = (snap: string, kind: string, label: string, after: string) => refOf(snap.slice(snap.indexOf(after)), kind, label);
  for (const title of ['Embedded form', 'Same-site form']) {
    const field = inFrame(s, 'text field', 'Name', title);
    assert.ok(field > 10_000, `numbered with its frame: ${field}`);
    await p.fill(field, 'Max');
    await p.select(inFrame(s, 'dropdown', 'Plan', title), 1);
    s = await view.click(p, inFrame(s, 'button', 'Send', title));
    assert.match(s, new RegExp(`Sent Max Paid`), s);
    s = await view.snapshot(p);
  }
  await p.close();
  server.close();
  site.close();
});

test('a pop-up over a frame says so, instead of clicking it', { skip }, async () => {
  view.allowAllFrames();
  const { server, port } = await serve({ '/': `<iframe srcdoc="<button>Inside</button>" style="width:400px;height:100px"></iframe>
    <div style="position:fixed;inset:0;background:#0009"><button>Accept cookies</button></div>` });
  const p = await open(`http://localhost:${port}/`);
  await new Promise(r => setTimeout(r, 300));
  const s = await view.snapshot(p);
  await assert.rejects(p.click(refOf(s, 'button', 'Inside')), /Something is on top of \[\d+\].*Accept cookies/);
  await p.close();
  server.close();
});

// Sites check for what automation leaves in a page. The page view lives in a world of
// its own, and the copy watch is there for the moment of a click only.
test("the page never sees the page view, and its copy functions are its own again after a click", { skip }, async () => {
  const { server, port } = await serve({ '/': `<button onclick="navigator.clipboard.writeText('x')">Copy</button>` });
  const p = await open(`http://localhost:${port}/`);
  const s = await view.snapshot(p);
  assert.equal(await p.evaluateInPage('typeof window.__eaa'), 'undefined');
  await view.click(p, refOf(s, 'button', 'Copy'));
  assert.equal(await p.evaluateInPage('typeof window.__eaaCopy'), 'undefined');
  assert.match(await p.evaluateInPage<string>('Clipboard.prototype.writeText.toString() + document.execCommand.toString()'), /^function writeText\(\) \{ \[native code\] \}function execCommand\(\) \{ \[native code\] \}$/);
  await p.close();
  server.close();
});

// An alert or confirm used to hold the page, and every call after it, for good.
test('an alert or a confirm is answered OK, and the agent is told what it said', { skip }, async () => {
  const p = await page(`<button onclick="if (confirm('Delete the draft?')) out.textContent = 'Deleted'; alert('Saved')">Delete</button><p id=out>kept</p>`);
  const s = await view.snapshot(p);
  const after = await view.click(p, refOf(s, 'button', 'Delete'));
  assert.match(after, /The page asked \(answered OK\): confirm: "Delete the draft\?"; alert: "Saved"/);
  assert.match(after, /Deleted/);
  await p.close();
});

test('Escape closes a pop-up that listens for it', { skip }, async () => {
  const p = await page(`<div id=pop>Subscribe to our newsletter</div><script>addEventListener('keydown', e => e.key === 'Escape' && pop.remove())</script>`);
  await p.press('Escape');
  assert.match(await view.snapshot(p), /\n\(no text\)\n/);
  await p.close();
});

// A security check's box used to be hidden from the agent, so every one waited for a person.
test("a security check's box is ticked by the agent, and it says when the check is gone", { skip }, async () => {
  view.allowAllFrames();
  const { server, port } = await serve({
    '/': `<form><input name=email><iframe id=cap style="width:300px;height:78px"></iframe><button>Send</button></form>
      <script>cap.src = 'http://127.0.0.1:' + location.port + '/recaptcha/api2/anchor'; addEventListener('message', e => e.data === 'ticked' && cap.remove())</script>`,
    '/recaptcha/api2/anchor': `<div id=recaptcha-anchor role=checkbox aria-checked=false style="width:24px;height:24px;border:2px solid" onclick="parent.postMessage('ticked', '*')"></div> I'm not a robot`,
  });
  const p = await open(`http://localhost:${port}/`);
  await new Promise(r => setTimeout(r, 800));
  const s = await view.snapshot(p);
  assert.match(s, /tick_security_check/);
  assert.match(await view.tick(p), /^Ticked, and the check is gone/);
  await p.close();
  server.close();
});

test("a hung page is still listed with its address and title: the browser says them, not the page (the agents' browser screen, 2026-11-13)", { skip }, async () => {
  // A run-away script, as six sign-up pages had: nothing inside the page answers any more.
  const p = await page('<title>Stuck sign-up</title><p>Sign up</p><script>setTimeout(() => { for (;;) {} }, 1000)</script>');
  await new Promise(r => setTimeout(r, 1400));
  const asked = Date.now();
  const info = await p.info();
  assert.ok(Date.now() - asked < 2000, 'the browser answers at once');
  assert.equal(info.title, 'Stuck sign-up');
  assert.match(info.url, /^data:text\/html/);
  // Asked inside the page it doesn't answer - what held the whole list for a minute.
  const inside = await Promise.race([p.url().then(() => 'answered', () => 'failed'), new Promise(r => setTimeout(() => r('no answer'), 1500))]);
  assert.equal(inside, 'no answer');
  // Its renderer ended, so the test doesn't wait out the hung page.
  await cdp.send('Target.closeTarget', { targetId: p.targetId }, undefined, 2000).catch(() => {});
});
