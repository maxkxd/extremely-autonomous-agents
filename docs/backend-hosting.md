# Where our backend runs

The official build's backend (`apps/backend`: sign-in through Clerk, the org
directory, invites, the relay, the anonymous reports) runs on **Railway**: one
Node service plus a Postgres database. Setup, settings and the API are in
[apps/backend/README.md](../apps/backend/README.md).

**Only the backend runs on Railway.** Hosted organisations (the paid plan) run
on a Hetzner server, many to a box, set up with
[deploy/vps/README.md](../deploy/vps/README.md). Never put an organisation's
agency on Railway: one busy organisation cost more there than the plan sells for.

## Its address

**`https://api.extremely.agency`** is the address the app, the join page
(extremely.agency/join) and cloud hosts use. It's a DNS-only CNAME on
Cloudflare pointing at the Railway service, so moving the backend means
pointing that record somewhere else. No app release is needed.

The Railway address (`*.up.railway.app`) still answers too.

Two settings carry the address:

| Where | Setting |
| --- | --- |
| The app's build (`apps/desktop/.env.local`, or the repository variable `EAA_BACKEND_URL` in the Release workflow) | `VITE_EAA_BACKEND_URL` |
| A cloud host ([hosting-in-the-cloud.md](hosting-in-the-cloud.md)) | `EAA_TOKEN_ISSUER` |

## The issuer

`PUBLIC_URL` on the backend is the **issuer** written into every org access
token. Each host only accepts tokens from the issuer it was set up with, and
fetches its keys from `<issuer>/.well-known/jwks.json`.

The app reads the issuer from the backend's `/config` when it starts. If the
org hosted on that computer was set up with a different one, the app restarts
it trusting the new one, and its relay reconnects there
(`apps/desktop/src/account.ts`, `apps/server/src/hosting.ts`). Builds from
before that change never update it.

So, to switch the issuer to `https://api.extremely.agency`:

1. Install a build with that change on every computer that hosts an
   organisation.
2. Set `PUBLIC_URL=https://api.extremely.agency` on the Railway service.
3. Set the same value as `EAA_TOKEN_ISSUER` on any cloud host.

Until then, `PUBLIC_URL` stays the Railway address.

## Redeploy

```bash
railway link -p celebrated-youth
railway redeploy -s extremely-autonomous-agents -y
```

A push to the default branch also deploys it (Root Directory `apps/backend`).
Check that `https://api.extremely.agency/health` answers `{"ok":true}`.

## Cost

About US$2.65 a month of usage (16 Oct to 16 Nov 2026). Most of it is relay
egress; the backend's RAM and the database are well under a dollar. That fits
inside the Hobby plan's US$5 included usage.

The project's hard usage limit is about US$25. The `org-host` service in the
same project is what used up the limit in November 2026: an org's agency
running in a container costs about US$1.50 a day. It is stopped, and its
volume is kept.
