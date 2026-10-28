import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addresses, bodyOf, encodeWord, htmlToText, rawEmail } from './modules/gmail.js';

const decoded = (raw: string) => Buffer.from(raw, 'base64url').toString();

test('an email is built safely: no header injection, UTF-8 subjects and bodies', () => {
  const raw = decoded(rawEmail({ to: 'dana@acme.com', cc: '', bcc: '', subject: 'Café plans ☕', body: 'Hi Dana,\nSee you.' }));
  const [head, body] = raw.split('\r\n\r\n');
  assert.match(head, /^To: dana@acme\.com\r\n/);
  assert.match(head, /Subject: =\?UTF-8\?B\?/);
  assert.doesNotMatch(head, /Cc:|Bcc:/);
  assert.equal(Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString(), 'Hi Dana,\r\nSee you.');
  assert.equal(encodeWord('plain'), 'plain');
  const long = encodeWord('ü'.repeat(60));
  assert.ok(long.split(' ').every(w => w.length <= 75));
});

test('addresses are checked, names encoded, and line breaks cannot add headers', () => {
  assert.equal(addresses('Dana W <dana@acme.com>, bob@acme.com', 'to'), 'Dana W <dana@acme.com>, bob@acme.com');
  assert.match(addresses('Zoë <zoe@acme.com>', 'to'), /^=\?UTF-8\?B\?.+\?= <zoe@acme\.com>$/);
  assert.throws(() => addresses('not an address', 'to'), /isn't an email address/);
  assert.throws(() => addresses('a@b.com\r\nBcc: evil@x.com', 'to'), /isn't an email address/);
});

test('a message reads as text: plain part first, else its HTML, attachments listed', () => {
  const b64 = (s: string) => Buffer.from(s).toString('base64url');
  const { text, attachments } = bodyOf({
    mimeType: 'multipart/mixed',
    parts: [
      { mimeType: 'multipart/alternative', parts: [{ mimeType: 'text/plain', body: { data: b64('Hello\r\nthere') } }, { mimeType: 'text/html', body: { data: b64('<p>Hello</p>') } }] },
      { mimeType: 'application/pdf', filename: 'invoice.pdf', body: { size: 20480, attachmentId: 'x' } },
    ],
  });
  assert.equal(text, 'Hello\nthere');
  assert.deepEqual(attachments, ['invoice.pdf (application/pdf, 20 KB)']);
  assert.equal(
    htmlToText('<style>p{}</style><p>Hi &amp; welcome</p><ul><li>One</li></ul><a href="https://x.com">site</a>'),
    'Hi & welcome\n- One\nsite (https://x.com)',
  );
});
