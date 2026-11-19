# Accounts: how agents sign up, and how the app knows it worked

Agents sign up for the website accounts their job needs (docs/integrations.md,
"Web tools"). This page is about the part that makes it reliable: the app keeps
its own record of every account an agent owes, and only the app decides that one
exists.

Code: `apps/server/src/runner/accounts.ts` (the record),
`apps/server/src/runner/browser.ts` (the tools, the kept pages, the one request).

## Why

An agent's word used to be all there was. It saved a password, started a
sign-up, met a CAPTCHA, and its summary said "signed up", with an account that
never existed sitting in the password store. Or the page it kept for the person
closed, and it gave up. And twelve sign-ups meant twelve requests, one per run.

## The record

Every account is written down before anyone signs up for it, and stays **owed**
until the app has seen it working or a person says they don't want it.

| State | Meaning |
|---|---|
| `needed` | Nobody is on it: never started, or the last try failed |
| `started` | A run is signing up right now |
| `waiting` | Its page is kept for the person (a CAPTCHA, a code) |
| `returned` | The person finished with its page: the agent finishes and checks it |
| `working` | The app saw it signed in. Its password is in the password store |
| `cancelled` | A person said no |

Rules the app enforces, whatever the agent says:

- **Hidden until it works.** A sign-up's password is not in the password store,
  for agents or in Settings, until the account is `working`.
- **The app checks, not the agent.** `check_account` reads the page the agent is
  on: it must be on that site, show no password box, not be a sign-up, sign-in
  or verification address, and show the account signed in (its email in full, its
  username as a word, or a sign-out link). The password must also have been read
  back as typed when it went into the form. Anything missing is said plainly and
  the account stays owed.
- **A try that can't be shown to have worked is a failed try.** The run ended
  before the check, the kept page closed, the browser restarted: the account goes
  back to `needed`.
- **Failed tries leave nothing behind, unless they might be real.** A password
  that never reached the site is deleted. One that was typed into the site is
  kept, still hidden: the site may have made the account without anyone seeing
  it, so the next try signs in with it first. If the site says there's no such
  account, it's deleted and a new one made.
- **Never given up on.** An owed account with nobody on it has its agent woken
  for it, at any ferocity: straight away, then 10 minutes, 40 minutes, 3 hours,
  12 hours and daily after each failed try.
- **Only a person ends one.** Turning its request down cancels the accounts in
  it. The Agency Engineer can cancel one too, with the person's own words.

## How an account signs in

Not every site has a password box. The agent says how each one signs in, when it
writes the account down or at `start_sign_up` (`sign_in`, plus `provider`):

| `sign_in` | The site | What's different |
|---|---|---|
| `password` (default) | Has a password box | Everything above |
| `email_code` | Emails a code or a sign-in link | No password is made. The agent reads the code from the inbox, or asks the person |
| `sso` | "Continue with Google / GitHub / Microsoft / Apple / Meta..." | No password. The provider's account must be signed in in that browser |
| `company_sso` | Sends a work account to the company's own sign-in (Entra ID, Okta, Google Workspace, SAML) | No password. Agents can't make the identity: it's a person's work account or one their IT made. Their password or MFA goes through `show_person`, never typed by the agent |

Accounts with no password are checked the same way: `check_account` reads the page.
The only thing skipped is "the password went in as typed". A page still on the
provider's own sign-in (accounts.google.com, login.microsoftonline.com, an Okta
domain) is named as such and isn't `working`. Once `working`, the account goes
into the password store as "signs in with X". `type_password` on it fails and says
how to sign in instead. Switching a try from a password to no password throws the
earlier password away. How each sign-in is named and recognised is in
`apps/server/src/runner/signin.ts`.

## The tools

| Tool | What it does |
|---|---|
| `signed_in_browser.accounts` | Lists what's owed and what works. `need` writes down every account, all at once |
| `signed_in_browser.start_sign_up` | Says which browser to use and, for a password account, makes the hidden password. `sign_in` says how the site signs in |
| `signed_in_browser.type_password` | Types it, and records whether the field kept it |
| `signed_in_browser.check_account` | The app reads the page. The only way an account becomes `working` |
| `signed_in_browser.show_person` | With `account_id`: keeps the page for the person, without asking yet |
| `signed_in_browser.wait_for_person` | Files the one request for every kept page, and waits |

A run's instructions carry the record under "Accounts you owe", so an agent can
neither forget one nor believe one it only thinks it made.

## One request for the whole batch

A sign-up stopped at something only a person can do is kept like any page for the
person (docs/browser-extension.md), but it is never asked for on its own.

1. The agent writes down every account, then works through them. At each check it
   calls `show_person` with the `account_id` and goes on to the next.
2. When every account is working or kept, it calls `wait_for_person`. That files
   **one** request listing each page, with its own button and its own Done.
   Pages kept later, while the request is still open, join it.
3. The run waits there for up to an hour. Waiting calls no model. When the person
   finishes, the same run carries on: each tab they pressed Done on is back in the
   agent's tabs, and it finishes each sign-up and calls `check_account`.
4. If the hour passes, the run ends. The agent is woken the moment the person
   finishes, whatever its ferocity.

A run that ends without calling `wait_for_person` still gets its pages asked for:
the request is filed when the run ends.

A page lost before the person got to it leaves the request, and its account is
owed again. The request closes by itself only when no page is left.

## A new agent's accounts

The builder can list the new accounts an agent can't start without (`accounts` in
its build, kept in `TOOLS.yaml`). While the agent is in setup:

- Each site is one item on the agent's card ("x.com account"), like a connector.
- The Agency Engineer makes them, in the same way as above, so the person does
  every check for them in one go.
- The item is ticked by the app, when it has seen that site's accounts working.

Once the person starts the agent, anything still owed is the agent's own to make.
An agent whose job is to keep making accounts writes down each batch itself.

## Putting things right

`reconcileAccounts` runs with every scheduler tick, so the record never stays on
a state nothing will move it from: a `started` account whose run is over has
failed; a `waiting` account whose request was answered some other way is
`returned` (or `cancelled`, if it was turned down); a `waiting` account with no
page is a failed try; kept pages nobody asked for are asked for.

Accounts saved before this existed show in the store as "NOT CONFIRMED". An agent
that signs in with one can have it checked with `check_account` and its
`password_id`.
