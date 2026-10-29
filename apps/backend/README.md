# Backend

Our backend: sign-in (Clerk), the directory of organisations, members, invites and hosts, and the **org access tokens** hosts trust. It never sees an agency's agents, runs or keys; those stay on the host. The design is in [docs/architecture.md](../../docs/architecture.md), "Accounts and organisations".

A self-hosted host doesn't need this backend: it issues the same tokens itself (phase 6).

## Run it locally

```bash
npm install
npm run dev
```

It listens on http://localhost:5180. Without `DATABASE_URL` it uses PGlite (real Postgres inside Node), kept in `.pglite/`. Copy `.env.example` to `.env` and fill in the Clerk values to sign in.

```bash
npm test
```

The tests need nothing set up: PGlite in memory, and a key of their own in place of Clerk's.

Until Clerk is set up (no `CLERK_JWKS_URL`) and outside production, the backend offers a **development sign-in**: any email and name, no code (`POST /dev/sign-in`). The app uses it when it has no Clerk publishable key, so the whole flow (several people, invites, roles) can be tried locally. It's off as soon as `CLERK_JWKS_URL` is set, and always with `NODE_ENV=production`.

## Settings

All from the environment: `.env` locally (gitignored), Railway's **Variables** in production. They never go in code, chat or commits.

| Variable | What |
| --- | --- |
| `CLERK_SECRET_KEY` | Clerk → API keys → Secret key. Reads names and emails. |
| `CLERK_JWKS_URL` | Clerk → API keys → JWKS URL. Checks sign-ins. |
| `CLERK_ISSUER` | Clerk → API keys → Frontend API URL. Sign-ins from another Clerk app are refused. |
| `ORG_TOKEN_PRIVATE_KEY` | From `npm run keygen`. Signs org access tokens. Required in production. A new one makes every app fetch a fresh token. |
| `PUBLIC_URL` | Where the backend is reached, e.g. `https://api.example.com`. It's the issuer hosts expect. |
| `DATABASE_URL` | Postgres. Railway sets it when you link its Postgres. |
| `PORT` | Railway sets it. Default 5180. |

## Clerk

1. Create an application at clerk.com. Pick the sign-in methods (email, Google, GitHub…).
2. Configure → API keys: copy the Secret key, JWKS URL and Frontend API URL into the variables above.
3. The desktop app gets the Publishable key as `VITE_CLERK_PUBLISHABLE_KEY` in `apps/desktop/.env.local` (see `apps/desktop/.env.example`). It's public, safe to ship in the app.
4. Turn on Email (verification code), Google and GitHub under User & authentication. Add `http://localhost:5174` to the allowed origins for development.

## Railway

1. New project → **Deploy from GitHub repo** → this repo. In the service's Settings, set **Root Directory** to `apps/backend`. Railway runs `npm start`.
2. **+ New → Database → PostgreSQL**. In the backend service's Variables, add `DATABASE_URL` as a reference to the database's `DATABASE_URL`.
3. Add the Clerk variables, `ORG_TOKEN_PRIVATE_KEY` (run `npm run keygen` locally and paste the line straight into Railway), `PUBLIC_URL` and `NODE_ENV=production`.
4. Settings → Networking → **Generate Domain** (or add your own). That URL is `PUBLIC_URL`.
5. Check `https://<domain>/health` answers `{"ok":true}`. The tables are made on start.

## API

Everything except `/health` and `/.well-known/jwks.json` needs `Authorization: Bearer <Clerk session token>`.

| | |
| --- | --- |
| `GET /me` | You, and every organisation you're in, personal agency first (made the first time). |
| `POST /orgs` `{name}` | Create your organisation. One owned each. |
| `PATCH /orgs/:id` `{name}` · `DELETE /orgs/:id` | Rename (owner, admin) · delete (owner). |
| `GET /orgs/:id/members` | Who's in it. |
| `PATCH /orgs/:id/members/:user` `{role}` · `DELETE …` | Change a role (owner) · remove someone (owner, or admin for members). |
| `POST /orgs/:id/leave` | Leave it. |
| `POST /orgs/:id/invites` `{email?, role?}` · `GET …` | Invite (owner, admin; admins invite members only) · pending invites. |
| `GET /invites/:code` · `POST /invites/:code/accept` · `DELETE /invites/:code` | Preview · accept · revoke. |
| `POST /orgs/:id/token` | An org access token for its host: 15 minutes, EdDSA, audience `eaa-host`. |
| `POST /orgs/:id/host` `{publicKey}` · `GET …` | Register the owner's machine as the host (returns its relay secret, once) · the host's public key. |
| `GET /.well-known/jwks.json` | The keys hosts check org access tokens against. |
