import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hasPassword, howToSignIn, parseSignIn, providerPage, signInOf, signInWords } from './signin.js';

// How an account signs in (signin.ts): what agents call it, in every way they call it.

test('a password is the default, and a provider with it is a mistake said plainly', () => {
  assert.deepEqual(parseSignIn(undefined), { method: 'password', provider: null });
  assert.deepEqual(parseSignIn(''), { method: 'password', provider: null });
  assert.deepEqual(parseSignIn('Password'), { method: 'password', provider: null });
  assert.throws(() => parseSignIn('password', 'google'), /Did you mean sign_in "sso", provider "google"/);
});

test('an emailed code or a magic link, by any of its names', () => {
  for (const s of ['email_code', 'email-code', 'Email code', 'magic link', 'magic_link', 'code', 'otp', 'passwordless', 'email link'])
    assert.deepEqual(parseSignIn(s), { method: 'email_code', provider: null }, s);
});

test('"Sign in with..." providers: their usual names, and given as sign_in itself', () => {
  const sso = (provider: string) => ({ method: 'sso', provider });
  assert.deepEqual(parseSignIn('sso', 'Google'), sso('google'));
  assert.deepEqual(parseSignIn('sso', 'GitHub'), sso('github'));
  assert.deepEqual(parseSignIn('sso', 'Microsoft account'), sso('microsoft'));
  assert.deepEqual(parseSignIn('sso', 'outlook'), sso('microsoft'));
  assert.deepEqual(parseSignIn('sso', 'Apple ID'), sso('apple'));
  assert.deepEqual(parseSignIn('sso', 'Facebook'), sso('meta'));
  assert.deepEqual(parseSignIn('sso', 'Twitter'), sso('x'));
  assert.deepEqual(parseSignIn('sso', 'LinkedIn'), sso('linkedin'));
  assert.deepEqual(parseSignIn('sso', 'Discord'), sso('discord'));
  assert.deepEqual(parseSignIn('google'), sso('google'));
  assert.deepEqual(parseSignIn('github'), sso('github'));
  // One the app doesn't know is kept as given.
  assert.deepEqual(parseSignIn('sso', 'Hugging Face'), sso('hugging face'));
  assert.throws(() => parseSignIn('sso'), /needs provider/);
});

test("a company's own sign-in: Entra ID by all its names, Okta, Workspace, plain SAML", () => {
  const co = (provider: string) => ({ method: 'company_sso', provider });
  for (const n of ['Entra', 'Entra ID', 'Azure AD', 'azure active directory', 'Microsoft Entra ID', 'Office 365', 'microsoft 365']) assert.deepEqual(parseSignIn('company_sso', n), co('entra'), n);
  assert.deepEqual(parseSignIn('company_sso', 'Okta'), co('okta'));
  assert.deepEqual(parseSignIn('company_sso', 'Google Workspace'), co('google_workspace'));
  assert.deepEqual(parseSignIn('company_sso', 'SAML'), co('saml'));
  assert.deepEqual(parseSignIn('company_sso', 'Acme Corp login'), co('acme corp login'));
  // Given as sso, or as sign_in itself, a company's provider is still the company's.
  assert.deepEqual(parseSignIn('sso', 'Okta'), co('okta'));
  assert.deepEqual(parseSignIn('azure ad'), co('entra'));
  assert.throws(() => parseSignIn('company_sso'), /needs provider[\s\S]*entra/);
});

test('something it can not tell apart is refused with the choices', () => {
  assert.throws(() => parseSignIn('fingerprint'), /isn't one the app knows[\s\S]*email_code[\s\S]*company_sso/);
});

test('rows: null is a password; how each is said', () => {
  assert.equal(hasPassword({ method: null }), true);
  assert.equal(hasPassword({ method: 'sso' }), false);
  assert.equal(hasPassword(undefined), true);
  assert.deepEqual(signInOf({ method: 'nonsense' }), { method: 'password', provider: null });
  assert.equal(signInWords({ method: 'password', provider: null }), 'a password');
  assert.equal(signInWords({ method: 'email_code', provider: null }), 'a code or link emailed to it');
  assert.equal(signInWords({ method: 'sso', provider: 'google' }), 'a Google account');
  assert.equal(signInWords({ method: 'sso', provider: 'apple' }), 'an Apple account');
  assert.equal(signInWords({ method: 'sso', provider: 'x' }), 'an X account');
  assert.equal(signInWords({ method: 'company_sso', provider: 'entra' }), "the company's Microsoft Entra ID sign-in");
});

test("a provider's sign-in page is told apart from the site's own", () => {
  assert.equal(providerPage('accounts.google.com', 'glama.ai'), 'Google');
  assert.equal(providerPage('github.com', 'glama.ai'), 'GitHub');
  assert.equal(providerPage('login.microsoftonline.com', 'notion.so'), 'Microsoft');
  assert.equal(providerPage('acme.okta.com', 'notion.so'), 'Okta');
  assert.equal(providerPage('adfs.acme.com', 'notion.so'), 'the company sign-in');
  // The site itself is never its own provider page: GitHub's own account on github.com.
  assert.equal(providerPage('github.com', 'github.com'), null);
  assert.equal(providerPage('login.glama.ai', 'glama.ai'), null);
  assert.equal(providerPage('glama.ai', 'glama.ai'), null);
});

test('how to get in: no password to type, where the code comes from, and the person for a company identity', () => {
  assert.match(howToSignIn({ method: 'email_code', provider: null }, 'me@bikes.test', 'glama.ai'), /no password[\s\S]*read the code or link from that inbox/);
  assert.match(howToSignIn({ method: 'sso', provider: 'github' }, 'me@bikes.test', 'glama.ai'), /Continue with GitHub[\s\S]*pick me@bikes\.test/);
  const co = howToSignIn({ method: 'company_sso', provider: 'entra' }, 'max@acme.com', 'notion.so');
  assert.match(co, /belongs to the company, and you can't make one/);
  assert.match(co, /show_person[\s\S]*never guess or type a person's work password/);
  assert.match(co, /only the company's IT can make it/);
  assert.equal(howToSignIn({ method: 'password', provider: null }, 'x', 'y'), '');
});
