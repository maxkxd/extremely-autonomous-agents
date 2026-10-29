import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inviteUrl, sendInvite } from './mail.js';

// Invite emails through Resend, or the link logged when it isn't set up.

test('no mail service: nothing sent, the link logged', async () => {
  delete process.env.RESEND_API_KEY;
  const r = await sendInvite({ to: 'cat@example.com', inviter: 'Ana', org: 'Ana Co', role: 'member', code: 'abc' }, () => {
    throw new Error('should not send');
  });
  assert.deepEqual(r, { sent: false, url: inviteUrl('abc') });
  assert.equal(inviteUrl('a b'), 'https://extremely.agency/join?code=a%20b');
});

test('with Resend: one email to them, from us, with the link, names escaped', async () => {
  process.env.RESEND_API_KEY = 're_test';
  process.env.RESEND_FROM_EMAIL = 'invites@extremely.agency';
  let sent: { url: string; body: Record<string, any>; auth: string } | null = null;
  const r = await sendInvite({ to: 'cat@example.com', inviter: 'Ana <script>', org: 'Ana & Co', role: 'admin', code: 'xyz' }, (async (url: string, init: any) => {
    sent = { url, body: JSON.parse(init.body), auth: init.headers.authorization };
    return new Response('{}', { status: 200 });
  }) as typeof fetch);
  try {
    assert.equal(r.sent, true);
    assert.equal(sent!.url, 'https://api.resend.com/emails');
    assert.equal(sent!.auth, 'Bearer re_test');
    assert.deepEqual(sent!.body.to, ['cat@example.com']);
    assert.equal(sent!.body.from, 'Extremely Autonomous Agents <invites@extremely.agency>');
    assert.match(sent!.body.html, /Ana &lt;script&gt;/);
    assert.match(sent!.body.html, /Ana &amp; Co/);
    assert.match(sent!.body.html, /join\?code=xyz/);
    assert.match(sent!.body.text, /as an admin/);
  } finally {
    delete process.env.RESEND_API_KEY;
    delete process.env.RESEND_FROM_EMAIL;
  }
});
