import '../test-data-dir.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Integration } from './schema.js';

const mcp = (cards: unknown) => ({
  kind: 'mcp',
  id: 'zoho-mail',
  name: 'Zoho Mail',
  what: 'Email',
  auth: { type: 'none' },
  url: 'https://example.com/mcp',
  cards,
});

test('an integration can say how its tools read on the Approvals page', () => {
  const parsed = Integration.parse(
    mcp({
      zohomail_send_mail: {
        wants_to: 'send an email',
        headers: [
          { label: 'To', value: '{body.toAddress}' },
          { label: 'Cc', value: '{body.ccAddress}', optional: true },
          { label: 'Subject', value: '{body.subject}' },
        ],
        body: '{body.content}',
      },
    }),
  );
  assert.equal(parsed.kind, 'mcp');
  assert.equal(parsed.cards?.zohomail_send_mail.headers.length, 3);
  // Headers may be left out: a card can be only a sentence and a body.
  assert.deepEqual(Integration.parse(mcp({ x: { wants_to: 'do it' } })).cards?.x.headers, []);
});

test("a card's placeholders are arguments or fields inside them, nothing else", () => {
  assert.throws(() => Integration.parse(mcp({ x: { wants_to: 'send', headers: [{ label: 'To', value: '{body.to address}' }] } })));
  assert.throws(() => Integration.parse(mcp({ x: { wants_to: 'send', body: '{{content}}' } })));
  assert.throws(() => Integration.parse(mcp({ x: { headers: [] } })), 'wants_to is required');
});
