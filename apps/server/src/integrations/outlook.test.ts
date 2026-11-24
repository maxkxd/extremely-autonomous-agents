import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parse } from 'yaml';
import { gmail } from './modules/gmail.js';
import { describeRule, filterOf, labelsOf, matches, movedIds, outlook, parseQuery, person, recipients } from './modules/outlook.js';
import { Integration } from './schema.js';

test('Gmail-style searches become Graph searches: folder, KQL words, and the rest as a filter', () => {
  assert.deepEqual(parseQuery('in:inbox'), { folder: 'inbox', kql: [] });
  const q = parseQuery('from:dana@acme.com subject:"quarterly plan" is:unread newer_than:7d');
  assert.equal(q.folder, null, 'Gmail searches every folder unless told');
  assert.deepEqual(q.kql, ['from:dana@acme.com', 'subject:"quarterly plan"']);
  assert.equal(q.unread, true);
  assert.ok(q.after && Date.now() - Date.parse(q.after) > 6.9 * 86_400_000);
  const sent = parseQuery('in:sent to:bob@acme.com');
  assert.equal(sent.folder, 'sentitems');
  assert.deepEqual(sent.kql, ['to:bob@acme.com']);
  assert.equal(parseQuery('-from:noreply@x.com').kql[0], 'NOT from:noreply@x.com');
  assert.equal(parseQuery('is:starred has:attachment').starred, true);
  assert.equal(parseQuery('label:Invoices').category, 'Invoices');
  assert.equal(parseQuery('after:2026/11/01').after, '2026-11-01T00:00:00.000Z');
});

test('a filter always leads with the date, so Graph can sort newest first', () => {
  assert.equal(filterOf(parseQuery('in:inbox')), 'receivedDateTime ge 1900-01-01T00:00:00Z');
  assert.equal(
    filterOf({ folder: 'inbox', kql: [], unread: true, attachment: true, category: "Bob's" }),
    "receivedDateTime ge 1900-01-01T00:00:00Z and isRead eq false and hasAttachments eq true and categories/any(c:c eq 'Bob''s')",
  );
});

test("what a search can't filter is checked on the results", () => {
  const q = parseQuery('from:dana is:unread label:VIP');
  assert.equal(matches({ id: '1', isRead: false, categories: ['vip'] }, q), true);
  assert.equal(matches({ id: '2', isRead: true, categories: ['vip'] }, q), false);
  assert.equal(matches({ id: '3', isRead: false, categories: [] }, q), false);
});

test('addresses are checked, and line breaks cannot add recipients', () => {
  assert.deepEqual(recipients('Dana W <dana@acme.com>, bob@acme.com', 'to'), [{ emailAddress: { name: 'Dana W', address: 'dana@acme.com' } }, { emailAddress: { address: 'bob@acme.com' } }]);
  assert.throws(() => recipients('not an address', 'to'), /isn't an email address/);
  // A line break is flattened, so the smuggled address is caught as one bad entry.
  assert.throws(() => recipients('a@b.com\r\nBcc: evil@x.com', 'to'), /isn't an email address/);
});

test('messages read like Gmail: people, labels from read/flag/importance/categories', () => {
  assert.equal(person({ emailAddress: { name: 'Dana', address: 'dana@acme.com' } }), 'Dana <dana@acme.com>');
  assert.equal(person({ emailAddress: { name: 'dana@acme.com', address: 'dana@acme.com' } }), 'dana@acme.com');
  assert.deepEqual(labelsOf({ id: 'x', isRead: false, flag: { flagStatus: 'flagged' }, importance: 'high', categories: ['Invoices'] }, 'inbox'), ['inbox', 'unread', 'starred', 'important', 'Invoices']);
});

test('a rule reads in words, forwarding included, so a person sees what it does', () => {
  assert.equal(
    describeRule(
      { id: 'r1', conditions: { fromAddresses: [{ emailAddress: { address: 'billing@acme.com' } }], subjectContains: ['invoice'], hasAttachments: true }, actions: { assignCategories: ['Invoices'], moveToFolder: 'A1', markAsRead: true } },
      id => (id === 'A1' ? 'archive' : undefined),
    ),
    'from:billing@acme.com subject:(invoice) has:attachment -> label Invoices, skip the inbox, mark read',
  );
  // One a person made in Outlook itself: shown, though no tool here makes them.
  assert.equal(describeRule({ id: 'r2', isEnabled: false, conditions: {}, actions: { forwardTo: [{ emailAddress: { address: 'me@elsewhere.com' } }] } }), '(any mail) -> forward to me@elsewhere.com (turned off)');
});

test("Outlook serves the standard email tools with Gmail's inputs, plus the calendar ones", () => {
  const ours = new Map(outlook.tools.map(t => [t.id, t]));
  for (const g of gmail.tools) {
    const o = ours.get(g.id);
    assert.ok(o, `${g.id} is missing`);
    assert.equal(o.tier, g.tier, `${g.id}'s tier`);
    const need = (g.input as { required?: string[] }).required ?? [];
    assert.deepEqual((o.input as { required?: string[] }).required ?? [], need, `${g.id}'s required inputs`);
  }
  assert.deepEqual(
    outlook.tools.filter(t => t.id.startsWith('calendar.')).map(t => [t.id, t.tier]),
    [['calendar.list_events', 'T0'], ['calendar.find_free_time', 'T0'], ['calendar.create_event', 'T2'], ['calendar.update_event', 'T2']],
  );
  // Sending, the auto-reply and invitations always wait for a person.
  for (const id of ['gmail.send_email', 'gmail.set_auto_reply', 'calendar.create_event', 'calendar.update_event']) assert.equal(ours.get(id)!.tier, 'T2');
});

test("the signature tool fails loudly: Outlook doesn't let apps set it", async () => {
  const t = outlook.tools.find(x => x.id === 'gmail.set_signature')!;
  await assert.rejects(() => t.run({ signature: 'Max' }, 'token', { fetch: async () => new Response() }), /doesn't let apps set the signature/);
});

test('rules refuse what Outlook can\'t do, instead of making half a rule', async () => {
  const t = outlook.tools.find(x => x.id === 'gmail.create_filter')!;
  const kit = { fetch: async () => new Response() };
  await assert.rejects(() => t.run({ from: 'a@b.com', star: true }, 'token', kit), /can't flag mail/);
  await assert.rejects(() => t.run({ from: 'a@b.com', never_spam: true }, 'token', kit), /out of Junk/);
});

test('the definition is valid and signs in with our Microsoft app on localhost', () => {
  const def = Integration.parse(parse(readFileSync(new URL('../../integrations/outlook.yaml', import.meta.url), 'utf8')));
  assert.equal(def.kind, 'code');
  assert.ok(def.auth.type === 'oauth2');
  if (def.auth.type !== 'oauth2') return;
  assert.equal(def.auth.shared, 'microsoft');
  assert.equal(def.auth.loopback, 'localhost');
  assert.ok(def.auth.scopes.includes('offline_access'), 'no refresh token without offline_access');
});

test('a move that changes ids (outlook.com) says the new ones; one that keeps them says nothing', () => {
  assert.equal(movedIds(['a', 'b'], ['a', 'b']), '');
  assert.equal(movedIds(['a', 'b'], ['a2', 'b']), ' Their ids changed with the move - use these from now on: a is now a2.');
  assert.equal(movedIds(['a'], [undefined]), '');
});
