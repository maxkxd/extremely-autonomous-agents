// Emails we send (as World Asset Register does): invites, through Resend.
// RESEND_API_KEY and RESEND_FROM_EMAIL (a sender on a domain verified in
// Resend) turn it on; RESEND_FROM_NAME names the sender. Without them, the
// link is logged instead, so development and tests need no mail service.

const escape = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

// Where an invite's link goes: the join page on our site, which says who
// invited them and how to get the app (extremely-agency-site/join).
export const inviteUrl = (code: string) => `${(process.env.INVITE_URL ?? 'https://extremely.agency/join').replace(/\/$/, '')}?code=${encodeURIComponent(code)}`;

export type Sent = { sent: boolean; url: string };

export async function sendInvite(o: { to: string; inviter: string; org: string; role: string; code: string }, send = fetch): Promise<Sent> {
  const url = inviteUrl(o.code);
  const key = process.env.RESEND_API_KEY?.trim();
  const from = process.env.RESEND_FROM_EMAIL?.trim();
  if (!key || !from) {
    console.log(`[invite, no mail service set up] to=${o.to} org=${o.org} url=${url}`);
    return { sent: false, url };
  }
  const as = o.role === 'admin' ? 'an admin' : 'a member';
  const html = `<div style="font-family:'IBM Plex Sans','Segoe UI',system-ui,sans-serif;font-size:15px;line-height:1.5;color:#1a1a1a">
<p><strong>${escape(o.inviter)}</strong> invited you to join <strong>${escape(o.org)}</strong> on Extremely Autonomous Agents, as ${as}.</p>
<p><a href="${url}" style="display:inline-block;padding:10px 20px;background:#3f7bd6;color:#fff;border-radius:8px;text-decoration:none;font-weight:600">Join ${escape(o.org)}</a></p>
<p style="color:#6b6b6b;font-size:13px">Or open the app and sign in with this email address: the invite is waiting there. It lasts 14 days.</p>
</div>`;
  const res = await send('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      from: `${process.env.RESEND_FROM_NAME?.trim() || 'Extremely Autonomous Agents'} <${from}>`,
      to: [o.to],
      subject: `${o.inviter} invited you to join ${o.org}`,
      html,
      text: `${o.inviter} invited you to join ${o.org} on Extremely Autonomous Agents, as ${as}.\n\nJoin: ${url}\n\nOr open the app and sign in with this email address: the invite is waiting there. It lasts 14 days.`,
    }),
  });
  if (!res.ok) {
    console.error(`Resend answered ${res.status} for an invite to ${o.to}: ${(await res.text().catch(() => '')).slice(0, 300)}`);
    return { sent: false, url };
  }
  return { sent: true, url };
}
