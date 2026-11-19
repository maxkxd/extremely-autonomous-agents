import '../test-data-dir.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyEdits, approvalAccount, capResult, diffLine, editSection, findHeading, headingsOf, MAX_RESULT_CHARS, matchesAccount, senderOf, windowOf } from './agency-mcp-views.js';

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
