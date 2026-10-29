// The end-to-end encrypted session between a member's app and an organisation's
// host, over our relay (docs/architecture.md). Kept identical in
// apps/server/src/relay-crypto.ts and apps/desktop/src/relay-crypto.ts (a test
// checks); only WebCrypto, so it runs in Node and the app alike.
//
// The handshake is Noise "NK"-shaped: the app knows the host's static X25519
// public key (from our directory), the host knows nothing about the app (who
// it is comes inside, as an org access token).
//   app  -> host: e_app (32 bytes)
//   host -> app:  e_host (32 bytes) || seal(k_host, "eaa-ready")
//   keys = HKDF-SHA256(DH(e_app, s_host) || DH(e_app, e_host), info = org, e_app, e_host, s_host)
// Only the host's private key completes DH(e_app, s_host), so the app knows it
// reached the real host; the ephemeral DH gives every session fresh keys.
// Messages are AES-256-GCM, one key per direction, the nonce a counter: a
// replayed, reordered or altered message doesn't open.

const subtle = globalThis.crypto.subtle;
// Bytes backed by a plain ArrayBuffer: what WebCrypto takes.
export type Bytes = Uint8Array<ArrayBuffer>;
const enc = new TextEncoder();
const PROTOCOL = 'eaa-relay-v1';
const READY = 'eaa-ready';

export type Session = { seal(plain: Bytes): Promise<Bytes>; open(sealed: Bytes): Promise<Bytes> };

export const toB64url = (b: Bytes) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const fromB64url = (s: string): Bytes => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
export const toB64 = (b: Bytes) => {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
};
export const fromB64 = (s: string): Bytes => Uint8Array.from(atob(s), c => c.charCodeAt(0));

const concat = (...parts: Bytes[]): Bytes => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) (out.set(p, at), (at += p.length));
  return out;
};
const ephemeral = async () => {
  const pair = (await subtle.generateKey({ name: 'X25519' }, true, ['deriveBits'])) as CryptoKeyPair;
  return { privateKey: pair.privateKey, raw: new Uint8Array(await subtle.exportKey('raw', pair.publicKey)) };
};
const publicKey = (raw: Bytes) => subtle.importKey('raw', raw, { name: 'X25519' }, false, []);
const dh = async (priv: CryptoKey, pubRaw: Bytes) => new Uint8Array(await subtle.deriveBits({ name: 'X25519', public: await publicKey(pubRaw) }, priv, 256));

async function keys(ikm: Bytes, orgId: string, eApp: Bytes, eHost: Bytes, sHost: Bytes) {
  const base = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const salt = new Uint8Array(await subtle.digest('SHA-256', enc.encode(PROTOCOL)));
  const info = concat(enc.encode(`${PROTOCOL}|${orgId}|`), eApp, eHost, sHost);
  const bits = new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, base, 512));
  const aes = (b: Bytes) => subtle.importKey('raw', b, 'AES-GCM', false, ['encrypt', 'decrypt']);
  return { toHost: await aes(bits.slice(0, 32)), toApp: await aes(bits.slice(32)) };
}

// One direction: its key, and a counter as the nonce - each message once, in order.
function direction(key: CryptoKey, tag: number) {
  let n = 0n;
  const nonce = () => {
    const iv = new Uint8Array(12);
    new DataView(iv.buffer).setBigUint64(4, n++);
    return iv;
  };
  const aad = new Uint8Array([tag]);
  return {
    seal: async (plain: Bytes) => new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: nonce(), additionalData: aad }, key, plain)),
    open: async (sealed: Bytes) => new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: nonce(), additionalData: aad }, key, sealed)),
  };
}

// The app's side: its hello, then the host's reply finishes it (or throws: not the real host).
export async function appHandshake(orgId: string, hostPublicKey: string) {
  const sHost = fromB64url(hostPublicKey);
  const e = await ephemeral();
  return {
    hello: e.raw,
    async finish(reply: Bytes): Promise<Session> {
      if (reply.length < 32 + 16) throw new Error('Not a host’s reply.');
      const eHost = reply.slice(0, 32);
      const k = await keys(concat(await dh(e.privateKey, sHost), await dh(e.privateKey, eHost)), orgId, e.raw, eHost, sHost);
      const toHost = direction(k.toHost, 1);
      const toApp = direction(k.toApp, 2);
      let ready = '';
      try {
        ready = new TextDecoder().decode(await toApp.open(reply.slice(32)));
      } catch {
        // falls through
      }
      if (ready !== READY) throw new Error('That isn’t this organisation’s host (its key doesn’t match).');
      return { seal: toHost.seal, open: toApp.open };
    },
  };
}

// The host's side: its static private key (PKCS#8) and public key, and the app's hello.
export async function hostHandshake(orgId: string, staticPrivatePkcs8: Bytes, staticPublic: Bytes, hello: Bytes) {
  if (hello.length !== 32) throw new Error('Not an app’s hello.');
  const sPriv = await subtle.importKey('pkcs8', staticPrivatePkcs8, { name: 'X25519' }, false, ['deriveBits']);
  const e = await ephemeral();
  const k = await keys(concat(await dh(sPriv, hello), await dh(e.privateKey, hello)), orgId, hello, e.raw, staticPublic);
  const toHost = direction(k.toHost, 1);
  const toApp = direction(k.toApp, 2);
  const reply = concat(e.raw, await toApp.seal(enc.encode(READY)));
  return { reply, session: { seal: toApp.seal, open: toHost.open } as Session };
}
