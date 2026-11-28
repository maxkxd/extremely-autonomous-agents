import '../test-data-dir.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyEdits, approvalAccount, approvalLine, capResult, diffLine, editSection, findHeading, headingsOf, MAX_RESULT_CHARS, matchesAccount, senderOf, windowOf } from './agency-mcp-views.js';

const MD = '# Media\n\nIntro.\n\n## Pitches\n\nOne a day.\n\n### Shape\n\nShort.\n\n```\n# not a heading\n```\n\n## Follow-ups\n\nAfter 5 days.\n';

test('headings: sections end at the next heading at their level or above, code fences ignored', () => {
  const hs = headingsOf(MD);
  assert.deepEqual(hs.map(h => `${h.level} ${h.text}`), ['1 Media', '2 Pitches', '3 Shape', '2 Follow-ups']);
  const p = findHeading(MD, 'pitches');
  assert.match(MD.slice(p.start, p.end), /^## Pitches[\s\S]*# not a heading[\s\S]*```\n\n$/);
  assert.equal(findHeading(MD, 'follow').text, 'Follow-ups');
  assert.throws(() => findHeading(MD, 'nope'), /No heading "nope". Its headings: Media \| Pitches/);
});

test('editSection: replace keeps the heading, delete takes it all, append with no heading goes to the end', () => {
  const r = editSection(MD, 'Shape', 'Long, now.', 'replace');
  assert.match(r, /### Shape\n\nLong, now\.\n\n## Follow-ups/);
  assert.doesNotMatch(r, /Short\./);
  const d = editSection(MD, 'Follow-ups', '', 'delete');
  assert.doesNotMatch(d, /Follow-ups|After 5 days/);
  assert.match(editSection(MD, 'Pitches', 'Pace sends 3 min apart.', 'append'), /# not a heading\n```\n\nPace sends 3 min apart\.\n\n## Follow-ups/);
  assert.match(editSection(MD, null, '## Sending\n\nPace first.', 'append'), /After 5 days\.\n\n## Sending\n\nPace first\.\n$/);
  assert.throws(() => editSection(MD, null, 'x', 'replace'), /only mode: append/);
});

test('applyEdits: each old text exactly once, or nothing changes', () => {
  assert.equal(applyEdits('a b c', [{ old: 'b', new: 'B' }]), 'a B c');
  assert.throws(() => applyEdits('a a', [{ old: 'a', new: 'x' }]), /matches 2 places/);
  assert.throws(() => applyEdits('a', [{ old: 'z', new: 'x' }]), /isn’t in the file/);
  assert.equal(applyEdits('$1 off', [{ old: '$1', new: '$$2' }]), '$$2 off', 'replacement text is taken literally');
});

test('windows and the size cap say exactly how to get the rest', () => {
  const long = 'x'.repeat(40_000);
  const w = windowOf(long, 0, 1000, 'CHARTER.md');
  assert.match(w, /characters 0-1000 of 40000\. Next: offset 1000\./);
  assert.equal(windowOf('short', 0, undefined, 'KPI.yaml'), 'short');
  const capped = capResult('read_agent', long);
  assert.ok(capped.length < MAX_RESULT_CHARS + 400);
  assert.match(capped, /Cut at 20,000 of 40,000 characters\. For the rest, ask for one section/);
  assert.equal(capResult('builder_guide', long), long);
  assert.match(diffLine('a\nb\nc', 'a\nB\nc'), /Changed from line 2: 1 line out, 1 in/);
});

test("accounts: the runner's queue account, and the sender a person reads", () => {
  const zoho = { path_variables: { accountId: 'me' }, body: { fromAddress: 'Team <team@example.test>', toAddress: 'a@b.test' }, _why: 'x' };
  assert.equal(approvalAccount(zoho), '', 'nested sender: the tool’s one account, as approvals.ts queues it');
  assert.equal(senderOf(zoho), 'team@example.test');
  assert.ok(matchesAccount(zoho, 'team@example.test'));
  assert.equal(approvalAccount({ from: 'Sales@Example.test', to: 'x' }), 'sales@example.test');
});

test('a long JSON answer is cut by whole items and stays JSON: the oldest posts go, older_until follows, and it says how to get the rest', () => {
  const posts = Array.from({ length: 40 }, (_, i) => ({ at: new Date(Date.UTC(2026, 10, 1, i)).toISOString(), from: 'Sam Rivera', text: `Post ${i} \u0007 ${'y'.repeat(900)}` }));
  const tasks = Array.from({ length: 14 }, (_, i) => ({ id: i, task: 'z'.repeat(9000), status: 'open' }));
  const text = JSON.stringify({ agent: 'Researcher (researcher)', posts, older_until: undefined, tasks }, null, 2);
  assert.ok(text.length > MAX_RESULT_CHARS);
  const capped = capResult('agent_activity', text);
  assert.ok(capped.length <= MAX_RESULT_CHARS);
  const v = JSON.parse(capped);
  assert.match(v.cut, /left out\)\. For the rest, pass a smaller limit/);
  assert.ok(v.posts.length > 0 && v.posts.length < 40);
  assert.equal(v.posts.at(-1).text.slice(0, 7), 'Post 39', 'the newest kept');
  assert.equal(v.older_until, v.posts[0].at);
  assert.ok(v.tasks.every((t: { task: string }) => t.task.length < 5000), 'long texts shortened');
  const list = JSON.stringify(Array.from({ length: 100 }, (_, i) => ({ id: i, what: 'w'.repeat(500) })));
  const cl = JSON.parse(capResult('list_agents', list));
  assert.equal(cl[0].id, 0);
  assert.match(cl.at(-1), /^Cut to fit/);
});

test("a share waiting for approval says which file, how, and with whom", () => {
  const row = { id: 'a9', agent_id: 'writer', tool: 'docs.share_document', args: JSON.stringify({ id: '1AbCdEf', with: 'jo@northside.test', role: 'commenter', message: 'For your review', _why: 'Jo reviews the draft' }), created_at: 0, expires_at: 0 };
  const l = approvalLine(row as never, 'Writer');
  assert.equal(l.what, 'commenter access to 1AbCdEf');
  assert.equal(l.to, 'jo@northside.test');
});
