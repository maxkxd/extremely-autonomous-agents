// How a website account signs in (accounts.ts, passwords.ts). Not every site has a
// password box: many sign in only by a code or link sent to the email address, and
// many only through another account (Google, GitHub, Microsoft...). A work site may
// send everyone through their company's own sign-in (Microsoft Entra ID, Okta...).
//
//   password     a password from the store, typed with type_password
//   email_code   a code or a sign-in link sent to the account's email address
//   sso          "Sign in with Google / GitHub / Microsoft / Apple / Meta..." - the
//                account is that provider's account, signed in in the same browser
//   company_sso  a company's own sign-in (Entra ID, Okta, Google Workspace, any SAML):
//                the identity belongs to the company, so agents can't make one - it is
//                a person's work account, or one their IT made, and signing in may need
//                that person (their password, their MFA)
//
// Only a password account has a secret in the vault. Every other one is still in the
// password store - as "signs in with X" - so a later run knows how to get back in.

export type SignInMethod = 'password' | 'email_code' | 'sso' | 'company_sso';
export type SignIn = { method: SignInMethod; provider: string | null };
export const PASSWORD: SignIn = { method: 'password', provider: null };

// The providers agents meet, by every name they get called. Anything else is kept as given.
const PROVIDERS: Record<string, string[]> = {
  google: ['google', 'gmail', 'google account'],
  github: ['github', 'git hub'],
  microsoft: ['microsoft', 'microsoft account', 'outlook', 'live', 'hotmail', 'msa'],
  apple: ['apple', 'apple id', 'icloud', 'sign in with apple'],
  meta: ['meta', 'facebook', 'fb', 'instagram'],
  linkedin: ['linkedin'],
  x: ['x', 'twitter'],
  discord: ['discord'],
  gitlab: ['gitlab'],
  slack: ['slack'],
  amazon: ['amazon', 'login with amazon'],
};
// Company identity providers: their names, and the hosts their sign-in pages are on.
const COMPANY_IDPS: Record<string, string[]> = {
  entra: ['entra', 'entra id', 'azure ad', 'azure active directory', 'microsoft entra', 'microsoft entra id', 'office 365', 'microsoft 365', 'aad'],
  okta: ['okta'],
  google_workspace: ['google workspace', 'workspace', 'g suite', 'gsuite'],
  onelogin: ['onelogin', 'one login'],
  ping: ['ping', 'ping identity', 'pingone', 'pingfederate'],
  jumpcloud: ['jumpcloud'],
  auth0: ['auth0'],
  adfs: ['adfs', 'ad fs', 'active directory federation services'],
  saml: ['saml', 'sso', 'company sso', 'enterprise sso', 'single sign-on', 'single sign on', 'oidc'],
};

const clean = (s: unknown) => String(s ?? '').trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
function lookup(table: Record<string, string[]>, raw: string): string | null {
  const s = clean(raw);
  for (const [key, names] of Object.entries(table)) if (s === key.replace(/_/g, ' ') || names.includes(s)) return key;
  return null;
}

// What an agent said (sign_in and provider) -> how the account signs in. Throws, in the
// agent's words, on something that can't be told apart.
export function parseSignIn(sign_in: unknown, provider?: unknown): SignIn {
  const how = clean(sign_in);
  const who = String(provider ?? '').trim();
  if (!how || how === 'password') {
    if (who) throw new Error(`provider goes with sign_in "sso" or "company_sso", not a password account. Did you mean sign_in "sso", provider "${who}"?`);
    return PASSWORD;
  }
  if (['email code', 'email', 'code', 'magic link', 'email link', 'link', 'otp', 'passwordless'].includes(how)) return { method: 'email_code', provider: null };
  if (how === 'company sso') {
    if (!who) throw new Error('sign_in "company_sso" needs provider: the company\'s sign-in it goes to - "entra" (Microsoft Entra ID / Azure AD / Office 365), "okta", "google_workspace", "onelogin", or the name the page shows.');
    return { method: 'company_sso', provider: lookup(COMPANY_IDPS, who) ?? clean(who).slice(0, 60) };
  }
  if (how === 'sso') {
    if (!who) throw new Error('sign_in "sso" needs provider: whose "Sign in with..." button - google, github, microsoft, apple, meta, linkedin, x, discord, gitlab, slack...');
    const known = lookup(PROVIDERS, who);
    if (known) return { method: 'sso', provider: known };
    const company = lookup(COMPANY_IDPS, who);
    if (company) return { method: 'company_sso', provider: company };
    return { method: 'sso', provider: clean(who).slice(0, 60) };
  }
  // "google", "github"... given as sign_in itself.
  const known = lookup(PROVIDERS, how);
  if (known) return { method: 'sso', provider: known };
  const company = lookup(COMPANY_IDPS, how);
  if (company) return { method: 'company_sso', provider: company };
  throw new Error(`sign_in "${String(sign_in)}" isn't one the app knows. Use "password", "email_code" (a code or link to the email address), "sso" with provider (google, github, microsoft, apple, meta...), or "company_sso" with provider (entra, okta...).`);
}

export const signInOf = (row: { method?: string | null; provider?: string | null } | null | undefined): SignIn => {
  const m = (row?.method ?? 'password') as SignInMethod;
  return { method: ['password', 'email_code', 'sso', 'company_sso'].includes(m) ? m : 'password', provider: row?.provider ?? null };
};
export const hasPassword = (row: { method?: string | null } | null | undefined) => signInOf(row).method === 'password';

const NICE: Record<string, string> = {
  google: 'Google',
  github: 'GitHub',
  microsoft: 'Microsoft',
  apple: 'Apple',
  meta: 'Meta (Facebook)',
  linkedin: 'LinkedIn',
  x: 'X',
  discord: 'Discord',
  gitlab: 'GitLab',
  slack: 'Slack',
  amazon: 'Amazon',
  entra: 'Microsoft Entra ID',
  okta: 'Okta',
  google_workspace: 'Google Workspace',
  onelogin: 'OneLogin',
  ping: 'Ping Identity',
  jumpcloud: 'JumpCloud',
  auth0: 'Auth0',
  adfs: 'AD FS',
  saml: 'company SSO',
};
export const providerName = (p: string | null) => (p ? (NICE[p] ?? p) : '');

// After "signs in with": "a password", "a code or link emailed to it", "a Google
// account", "the company's Okta sign-in".
export function signInWords(s: SignIn): string {
  if (s.method === 'email_code') return 'a code or link emailed to it';
  if (s.method === 'sso') {
    const name = providerName(s.provider);
    return `${/^([aeiou]|x$)/i.test(name) ? 'an' : 'a'} ${name} account`;
  }
  if (s.method === 'company_sso') return `the company's ${providerName(s.provider)} sign-in`;
  return 'a password';
}

// The hosts sign-in providers' own pages are on: a check there is still mid sign-in.
const PROVIDER_HOSTS: [RegExp, string][] = [
  [/(^|\.)accounts\.google\.com$/, 'Google'],
  [/(^|\.)github\.com$/, 'GitHub'],
  [/(^|\.)(login\.microsoftonline\.com|login\.live\.com|login\.microsoft\.com|account\.microsoft\.com|login\.windows\.net)$/, 'Microsoft'],
  [/(^|\.)appleid\.apple\.com$/, 'Apple'],
  [/(^|\.)(facebook\.com|instagram\.com)$/, 'Meta'],
  [/(^|\.)linkedin\.com$/, 'LinkedIn'],
  [/(^|\.)(x\.com|twitter\.com)$/, 'X'],
  [/(^|\.)discord\.com$/, 'Discord'],
  [/(^|\.)gitlab\.com$/, 'GitLab'],
  [/(^|\.)slack\.com$/, 'Slack'],
  [/(^|\.)(okta\.com|oktapreview\.com|okta-emea\.com)$/, 'Okta'],
  [/(^|\.)onelogin\.com$/, 'OneLogin'],
  [/(^|\.)(pingone\.com|pingidentity\.com)$/, 'Ping Identity'],
  [/(^|\.)jumpcloud\.com$/, 'JumpCloud'],
  [/(^|\.)auth0\.com$/, 'Auth0'],
  [/^(adfs|sts|fs|sso|login|idp)\./, 'the company sign-in'],
];
// Whose sign-in page this host is, if it's one (and not the site's own).
export function providerPage(host: string, siteBase: string): string | null {
  const h = host.toLowerCase();
  for (const [re, name] of PROVIDER_HOSTS) if (re.test(h) && !(h === siteBase || h.endsWith(`.${siteBase}`))) return name;
  return null;
}

// How the agent gets in, for the start of a sign-up and for the store's list.
export function howToSignIn(s: SignIn, username: string, site: string): string {
  if (s.method === 'email_code')
    return `${site} signs in by a code or link emailed to ${username}: there is no password. On its sign-up or sign-in page, enter ${username}, then read the code or link from that inbox (your email tools) and use it. No access to that inbox: signed_in_browser.show_person with the account_id.`;
  if (s.method === 'sso')
    return `${site} signs in with ${providerName(s.provider)}: there is no password for ${site} itself. Use a browser where the ${providerName(s.provider)} account ${username} is already signed in (signed_in_browser.passwords shows which browser has it), press the site's "Continue with ${providerName(s.provider)}" button and pick ${username}; allow access if it asks. Not signed in to ${providerName(s.provider)} in that browser: sign in to it first (type_password with its own password number), or show_person with the account_id if it needs a person.`;
  if (s.method === 'company_sso')
    return `${site} signs in through the company's ${providerName(s.provider)} sign-in: the identity ${username} belongs to the company, and you can't make one. Use the browser where that work account is already signed in - usually the person's own (pass its browser) - enter ${username} on ${site}, and let it send you to ${providerName(s.provider)} and back. If ${providerName(s.provider)} asks for a password, an authenticator or a phone you don't have: signed_in_browser.show_person with the account_id - never guess or type a person's work password. If ${username} doesn't exist yet, only the company's IT can make it: say so to the person.`;
  return '';
}
