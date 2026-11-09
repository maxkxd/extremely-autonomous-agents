import '../test-data-dir.js';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
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
