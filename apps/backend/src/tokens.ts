import { createHash, randomBytes } from 'node:crypto';
import { createRemoteJWKSet, exportJWK, generateKeyPair, importPKCS8, jwtVerify, SignJWT, calculateJwkThumbprint, type JWK, type JWTVerifyGetKey, type CryptoKey } from 'jose';
import type { Profile, Role } from './directory.js';

// Who's calling, and the token a host trusts (docs/architecture.md):
//   - a sign-in: the session token from Clerk, checked against Clerk's keys;
//   - an org access token: what this backend hands a member for one of their
//     organisations - this person, this organisation, this role - short-lived
//     and signed with our key. A host checks it against our published keys
//     (/.well-known/jwks.json) and never needs to know about Clerk. A
//     self-hosted host issues the same token itself.

export const ORG_TOKEN_AUDIENCE = 'eaa-host';
export const ORG_TOKEN_MINUTES = 15;
export type OrgClaims = { sub: string; org: string; role: Role; name: string; kind: 'personal' | 'team' };

export type Auth = {
  // The caller's id from their Clerk session token, or null if it isn't one.
  session(token: string): Promise<string | null>;
  // Their name and email (from Clerk), for the directory.
  profile(userId: string): Promise<Profile>;
  orgToken(claims: OrgClaims): Promise<{ token: string; expiresAt: number }>;
  jwks(): Promise<{ keys: JWK[] }>;
  // Who org tokens say issued them: what a host is told to trust.
  issuer: string;
  // Development without Clerk: sign in as anyone by email, no code (never in production).
  devSignIn?(email: string, name: string): Promise<{ token: string }>;
};

// No Clerk set up and not production: the development sign-in. Lets the app's
// whole flow (several people, invites, roles) be tried before Clerk exists.
export const devSignInOn = (env = process.env) => !env.CLERK_JWKS_URL && env.NODE_ENV !== 'production';

type Signer = { key: CryptoKey; jwk: JWK };

async function signer(pem = process.env.ORG_TOKEN_PRIVATE_KEY): Promise<Signer> {
  let key: CryptoKey;
  let jwk: JWK;
  if (pem) {
    key = await importPKCS8(pem.replace(/\\n/g, '\n'), 'EdDSA', { extractable: true });
    const full = await exportJWK(key);
    jwk = { kty: full.kty, crv: full.crv, x: full.x };
  } else {
    if (process.env.NODE_ENV === 'production') throw new Error('ORG_TOKEN_PRIVATE_KEY is not set (see apps/backend/README.md).');
    // Development: a key for this run only. Hosts trusting this backend refetch the keys.
    const pair = await generateKeyPair('EdDSA', { extractable: true });
    key = pair.privateKey;
    jwk = await exportJWK(pair.publicKey);
    console.warn('No ORG_TOKEN_PRIVATE_KEY: org tokens are signed with a key that lasts until this backend restarts.');
  }
  const kid = await calculateJwkThumbprint(jwk);
  return { key, jwk: { ...jwk, kid, alg: 'EdDSA', use: 'sig' } };
}

// Clerk's user record: the primary email and a display name.
async function clerkProfile(userId: string): Promise<Profile> {
  const secret = process.env.CLERK_SECRET_KEY;
  if (!secret) throw new Error('CLERK_SECRET_KEY is not set.');
  const res = await fetch(`https://api.clerk.com/v1/users/${encodeURIComponent(userId)}`, { headers: { authorization: `Bearer ${secret}` } });
  if (!res.ok) throw new Error(`Clerk answered ${res.status} for the user.`);
  const u = (await res.json()) as {
    first_name?: string | null;
    last_name?: string | null;
    username?: string | null;
    primary_email_address_id?: string | null;
    email_addresses?: { id: string; email_address: string }[];
  };
  const email = u.email_addresses?.find(e => e.id === u.primary_email_address_id)?.email_address ?? u.email_addresses?.[0]?.email_address ?? '';
  const name = [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || email.split('@')[0] || '';
  return { id: userId, email, name };
}

export async function createAuth(opts: {
  // Clerk's signing keys; tests pass their own.
  sessionKeys?: JWTVerifyGetKey;
  sessionIssuer?: string;
  profile?: (userId: string) => Promise<Profile>;
  issuer?: string;
  privateKeyPem?: string;
  dev?: boolean;
} = {}): Promise<Auth> {
  const jwksUrl = process.env.CLERK_JWKS_URL;
  const dev = opts.dev ?? (!opts.sessionKeys && devSignInOn());
  // Signs development sessions; made each start, so a restart signs everyone out.
  const devKey = randomBytes(32);
  const devProfiles = new Map<string, Profile>();
  const sessionKeys = opts.sessionKeys ?? (jwksUrl ? createRemoteJWKSet(new URL(jwksUrl)) : null);
  const sessionIssuer = opts.sessionIssuer ?? process.env.CLERK_ISSUER;
  const issuer = opts.issuer ?? process.env.PUBLIC_URL ?? 'http://localhost:5180';
  const sign = await signer(opts.privateKeyPem);
  // Profiles change rarely; asked for at most every 10 minutes per person.
  const cache = new Map<string, { at: number; p: Profile }>();
  const profileOf = opts.profile ?? clerkProfile;

  return {
    issuer,
    async session(token) {
      if (dev) {
        try {
          const { payload } = await jwtVerify(token, devKey, { issuer: 'eaa-dev-sign-in' });
          if (typeof payload.sub !== 'string') return null;
          devProfiles.set(payload.sub, { id: payload.sub, email: String(payload.email ?? ''), name: String(payload.name ?? '') });
          return payload.sub;
        } catch {
          return null;
        }
      }
      if (!sessionKeys) throw new Error('CLERK_JWKS_URL is not set (see apps/backend/README.md).');
      try {
        const { payload } = await jwtVerify(token, sessionKeys, sessionIssuer ? { issuer: sessionIssuer } : {});
        return typeof payload.sub === 'string' ? payload.sub : null;
      } catch {
        return null;
      }
    },
    async profile(userId) {
      const devProfile = dev && devProfiles.get(userId);
      if (devProfile) return devProfile;
      const hit = cache.get(userId);
      if (hit && Date.now() - hit.at < 600_000) return hit.p;
      const p = await profileOf(userId);
      cache.set(userId, { at: Date.now(), p });
      return p;
    },
    async orgToken(c) {
      const expiresAt = Date.now() + ORG_TOKEN_MINUTES * 60_000;
      const token = await new SignJWT({ org: c.org, role: c.role, name: c.name, kind: c.kind })
        .setProtectedHeader({ alg: 'EdDSA', kid: sign.jwk.kid })
        .setSubject(c.sub)
        .setIssuer(issuer)
        .setAudience(ORG_TOKEN_AUDIENCE)
        .setIssuedAt()
        .setExpirationTime(Math.floor(expiresAt / 1000))
        .sign(sign.key);
      return { token, expiresAt };
    },
    async jwks() {
      return { keys: [sign.jwk] };
    },
    ...(dev && {
      async devSignIn(email: string, name: string) {
        const e = email.trim().toLowerCase();
        const id = `dev_${createHash('sha256').update(e).digest('hex').slice(0, 16)}`;
        const token = await new SignJWT({ email: e, name: name.trim() || e.split('@')[0] })
          .setProtectedHeader({ alg: 'HS256' })
          .setSubject(id)
          .setIssuer('eaa-dev-sign-in')
          .setIssuedAt()
          .setExpirationTime('30d')
          .sign(devKey);
        return { token };
      },
    }),
  };
}
