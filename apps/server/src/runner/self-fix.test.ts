import '../test-data-dir.js';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { DATA } from '../files.js';
import { addIntegration, connectIntegration, loadIntegrations, writeDraftIntegration, listIntegrations } from '../integrations/index.js';
import { all, one, resetDbForTests, run as exec } from './db.js';
import { fileGap, fixedHereFor, problemsIn, setBackendForTests } from './app-gaps.js';
import { publishable, sameDraftAlready, startEngineer } from './engineer.js';
import { FLEET_ENGINEER } from './agent.js';

// The loop that fixes the app's own gaps (docs/requests.md, "When the app itself
// falls short"), and the three Engineer bugs found dogfooding it on 2026-11-05/06.

// A stand-in MCP server (any key works), and a stand-in for our backend that keeps what it's sent.
let server: Server;
let base: string;
const reported: Record<string, unknown>[] = [];
before(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c)).on('end', () => {
      if (req.url === '/reports/app-gap') {
        reported.push(JSON.parse(body));
        return res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
      }
      const m = JSON.parse(body);
      if (m.id === undefined) return res.writeHead(202).end();
      const result = m.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: { tools: {} } } : { tools: [{ name: 'read', inputSchema: { type: 'object' } }] };
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }));
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  resetDbForTests();
  await loadIntegrations();
  setBackendForTests(base);
});
after(() => server.close());

async function agentOnDisk(id: string, name: string, tools: string) {
  const dir = join(DATA, id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'meta.json'), JSON.stringify({ name }));
  await writeFile(join(dir, 'CHARTER.md'), `# CHARTER - ${name}\nSubmits the product to directories.`);
  await writeFile(join(dir, 'TOOLS.yaml'), tools);
  await writeFile(join(dir, 'KPI.yaml'), 'output: []\n');
}
const request = (agent: string, what: string, extra = '') =>
  Number(exec(`INSERT INTO requests (agent_id, what, why, created_at, stage, status${extra ? ', waiting_on' : ''}) VALUES (?, ?, 'x', ?, 'waiting_you', 'open'${extra ? ', ?' : ''})`, agent, what, Date.now(), ...(extra ? [extra] : [])).lastInsertRowid);
const extension = (id: string, parent: string, tool: string, name = 'Stand-in Drive (more tools)') => `kind: http
id: ${id}
name: ${name}
what: More tools on the stand-in drive
key_from: ${parent}
base_url: https://drive.invalid
test: { tool: ${tool}, args: {} }
tools:
  - id: ${tool}
    tier: T1
    description: Record an outcome
    input: { type: object, properties: {} }
    request: { method: POST, path: /mark }
`;

test("connecting a service wakes the Engineer for the drafts built on it, and doesn't close their requests", async () => {
  await addIntegration({ kind: 'mcp', id: 'zz-drive', name: 'Stand-in Drive', what: 'x', auth: { type: 'bearer' }, url: `${base}/mcp`, local: true });
  // Holds the connection's own tool already, and waits on a draft extension of it for the rest.
  await agentOnDisk('zz-dir', 'Dir Bot', 'tools_allowed: [zz-drive.read]\ntool_tiers: { zz-drive.read: T0 }\nnew_tools:\n  - { id: zzdir.mark, description: Record an outcome }\n');
  const r = request('zz-dir', 'Set up Directories', 'zz-drive');
  await writeDraftIntegration(extension('zz-drive-more', 'zz-drive', 'zzdir.mark'), FLEET_ENGINEER, r);
  const booked: { agent: string; trigger: string; task: string }[] = [];
  startEngineer((agent, trigger, task) => void booked.push({ agent, trigger, task }));
  await connectIntegration('zz-drive', 'any-key');
  for (let i = 0; i < 50 && booked.filter(b => b.agent === FLEET_ENGINEER).length < 2; i++) await new Promise(res => setTimeout(res, 20));
  const forEngineer = booked.filter(b => b.agent === FLEET_ENGINEER).map(b => b.task).join('\n');
  assert.match(forEngineer, /draft integration "zz-drive-more" \(for request #\d+/, 'the draft built on it is tested now, not at the next daily run');
  assert.match(forEngineer, new RegExp(`#${r}\\b`));
  assert.equal(one<{ status: string }>('SELECT status FROM requests WHERE id = ?', r)?.status, 'open', 'its draft is still untested: the request stays open to publish it for');
  assert.ok(!booked.some(b => b.agent === 'zz-dir' && /is done/.test(b.task)), "the agent isn't told it's done");
});

test('a tested draft can go live for a request that closed meanwhile; a turned-down one stays closed', () => {
  const done = request('zz-dir', 'Record outcomes');
  exec("UPDATE requests SET status = 'done', answer = 'connected', answered_at = 1, stage = NULL WHERE id = ?", done);
  assert.equal(publishable(done).status, 'open');
  assert.deepEqual({ ...one('SELECT status, stage, answered_at FROM requests WHERE id = ?', done) }, { status: 'open', stage: 'engineer', answered_at: null });
  const no = request('zz-dir', 'Something they refused');
  exec("UPDATE requests SET status = 'rejected' WHERE id = ?", no);
  assert.throws(() => publishable(no), /already rejected/);
});

test('a second run building the same thing for the same agent is sent to the draft that exists', async () => {
  const list = await listIntegrations();
  const r1 = all<{ id: number }>("SELECT id FROM requests WHERE agent_id = 'zz-dir' AND what = 'Set up Directories'")[0].id;
  const r2 = request('zz-dir', 'Connect Stand-in Drive');
  // The same connection extended again under another id, for the agent's other request: refused.
  assert.throws(() => sameDraftAlready(extension('zz-directories', 'zz-drive', 'zzdir.mark2', 'Directories'), r2, list), /"zz-drive-more".*already a draft for request #\d+.*same zz-drive connection/);
  // The same name, likewise.
  assert.throws(() => sameDraftAlready(extension('zz-other', 'zz-elsewhere', 'zzdir.x'), r2, list), /already a draft/);
  // Rewriting the draft itself is how it's added to.
  sameDraftAlready(extension('zz-drive-more', 'zz-drive', 'zzdir.mark'), r1, list);
  // Another agent's need is its own.
  await agentOnDisk('zz-other-agent', 'Other Bot', 'tool_tiers: {}\n');
  sameDraftAlready(extension('zz-their-drive', 'zz-drive', 'zzo.mark', 'Their Drive'), request('zz-other-agent', 'Set up theirs'), list);
});

test("nothing that could say whose it is goes in a public report", () => {
  const words = ['Dir Bot', 'Jane Doe', 'Jane'];
  assert.deepEqual(problemsIn("The browser can't pick from a native dropdown on a directory's sign-up form (signed_in_browser.click).", words), []);
  const bad = problemsIn('Dir Bot failed on https://example.com/submit for jane@example.com, token zzzzzzzzzzzzzzzzzzzzzzzzzzzz', words);
  assert.ok(bad.some(p => /email/.test(p)));
  assert.ok(bad.some(p => /web address/.test(p)));
  assert.ok(bad.some(p => /long code/.test(p)));
  assert.ok(bad.some(p => /Dir Bot/.test(p)));
  assert.ok(problemsIn('Ask jane about it', words).some(p => /Jane/.test(p)));
});

test("a gap in the app is filed once, counted after that, and only its public part leaves", async () => {
  reported.length = 0;
  const gap = {
    by: FLEET_ENGINEER,
    area: 'browser',
    title: "The agents' browser can't pick from a native dropdown",
    failed: 'Sign-up forms with a native select element: every click on an option does nothing; the form never submits.',
    fix: 'A browser tool that picks an option by its label, for native selects and hidden radios.',
    tools: ['files.write_file'],
    agents: ['zz-dir'],
    runs: ['r_zz1'],
  };
  const first = await fileGap(gap);
  assert.equal(first.repeat, false);
  assert.equal(first.sent, true);
  const again = await fileGap({ ...gap, agents: ['zz-other-agent'], runs: ['r_zz2'] });
  assert.deepEqual([again.id, again.repeat, again.seen], [first.id, true, 2]);
  assert.equal(reported.length, 2);
  const sent = reported[1];
  assert.deepEqual(Object.keys(sent).sort(), ['agents', 'area', 'failed', 'fix', 'fixed_here', 'id', 'runs', 'seen', 'title', 'tools']);
  assert.deepEqual([sent.agents, sent.runs, sent.seen], [2, 2, 2], 'how many, never which');
  assert.ok(!JSON.stringify(reported).includes('zz-dir') && !JSON.stringify(reported).includes('r_zz'));
  // Kept here in full.
  assert.deepEqual(JSON.parse(one<{ agents: string }>('SELECT agents FROM app_gaps WHERE id = ?', first.id)!.agents), ['zz-dir', 'zz-other-agent']);
  // A connection's tool isn't the app's; and an agent's name is refused.
  await assert.rejects(fileGap({ ...gap, tools: ['zz-drive.read'] }), /isn't one of the app's own tools/);
  await assert.rejects(fileGap({ ...gap, title: 'Dir Bot cannot pick from dropdowns' }), /public issue list.*Dir Bot/);
});

test('a way round a gap going live is reported as fixed here, so the official build takes it up', async () => {
  reported.length = 0;
  const r = request('zz-dir', 'Pick from dropdowns');
  const { id } = await fileGap({ by: FLEET_ENGINEER, area: 'runner', title: 'A cap on steps a run cuts browser work short', failed: 'Runs stop after ten browser steps mid-form.', fix: 'No step cap on working one page.', requestId: r });
  assert.deepEqual(await fixedHereFor(r, 'A plugin that fills the form in one call went live here.'), [id]);
  assert.equal(reported.at(-1)?.fixed_here, 'A plugin that fills the form in one call went live here.');
  // Said in general terms when the summary names this agency's things.
  const r2 = request('zz-dir', 'Another');
  await fileGap({ by: FLEET_ENGINEER, area: 'scheduler', title: 'Runs woken twice for one event', failed: 'Two runs start for one wake.', fix: 'One run per wake.', requestId: r2 });
  await fixedHereFor(r2, 'Dir Bot now has a tool for it');
  assert.match(String(reported.at(-1)?.fixed_here), /^A connection the Agency Engineer built here/);
});
