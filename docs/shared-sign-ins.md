# Shared sign-ins (plan, 2026-10-31)

Today every OAuth integration makes the person create their own OAuth client
(Gmail: a Google Cloud project, a consent screen, a Desktop client - six
steps in `gmail.yaml`). That's fine for us testing and wrong for anyone else.
The plan: for the few big services, **we** register the app once, under World
Asset Register, and the person only signs in and approves. Bring-your-own stays
for everything else.

## How it works

- **The sign-in still runs on the person's own computer.** Same flow as today
  (`integrations/oauth.ts`): their browser, PKCE, back to
  `http://127.0.0.1:<port>`. Only the client changes: ours, shipped with the
  app, instead of one they made. Tokens are stored and refreshed on their host
  and never pass through our backend - as the architecture says, it never holds
  anything an agent touches.
- **A desktop client's "secret" isn't secret.** Google treats desktop apps as
  public clients that can't keep one (PKCE is the protection), so shipping our
  client ID (and its secret, where Google still wants it at the token step) in
  the app is the documented pattern. It's still kept out of git: put in at build
  time from the release environment, like the signing keys.
- **In the definition:** `auth.type: oauth2` gains `shared: <provider>`
  (`google`, `microsoft`, ...). With one, Connect is a single "Sign in with
  Google" button and `client_help` is hidden behind "Use your own client
  instead" (for an organisation that wants its own Google project). Without
  one, nothing changes.
- **One Google project for every Google integration** (Gmail, Calendar, Drive,
  Sheets...): one client, and each integration asks only for its own scopes
  when it's connected (incremental consent), so connecting Calendar never asks
  for email.
- **Services that need a real secret** to swap the code for tokens (some do,
  unlike Google's desktop flow) get it done by our backend: it holds the
  secret, does the swap and each refresh, and hands the tokens to the host. The
  backend then briefly sees those tokens - so only where the service leaves no
  other way, and said in the privacy policy.

## Order

1. **Google** (Gmail now; Calendar and Drive next). The slow one - start first.
2. **GitHub**: a GitHub App with the device flow (a code to type at
   github.com/login/device; no secret, no redirect). No review. Replaces the
   fine-grained token step.
3. **Microsoft 365** (Outlook, OneDrive, Teams): an Entra app registration for
   any organisation and personal accounts, as a public client with a loopback
   redirect. Publisher verification (needs a free Microsoft Partner Network ID)
   so people see our name; some organisations' admins must approve it once.
4. **Slack**: one app, public distribution switched on (the App Directory
   listing is optional). Check whether its token swap still needs the client
   secret; if it does, our backend does it (above).

Hosted MCP servers that sign in themselves (Notion, Linear: `mcp_oauth`) need
none of this.

## Every big service, and what it needs from us

From what's generally known of each; check each one's current rules when it
comes up.

**Our own app - worth registering** (sign-in only through an OAuth app, so
without ours the person has to make one):

| Service | What we register | Gate before the public can use it |
|---|---|---|
| Google Workspace (Gmail, Calendar, Drive, Sheets, Docs) | one Cloud project, Desktop client | verification; CASA yearly for restricted scopes |
| Microsoft 365 (Outlook, OneDrive, Teams, SharePoint) | Entra app, any organisation | publisher verification; some admins must consent |
| Slack | one app, public distribution | light; Directory listing optional |
| GitHub | GitHub App (device flow) | none |
| GitLab | OAuth application on gitlab.com | none (self-managed GitLab: theirs) |
| HubSpot | public app (developer account) | Marketplace listing optional |
| Salesforce | connected / external client app | none to sign in; AppExchange optional |
| Zoho (CRM, Desk, Books) | API console client, every data centre | none; today it's a "self client" per person |
| Xero | OAuth app | certification past a small number of connected organisations |
| QuickBooks Online | Intuit app | production keys need Intuit's app questionnaire |
| Zoom | Marketplace app | review to be public |
| Dropbox / Box | app | Dropbox: production approval past its user cap |
| Zendesk | global OAuth client | Zendesk must approve a global client |
| Shopify | public app | App Store review, or custom distribution per store |
| Discord | one shared bot | none; verification past 100 servers |
| Calendly, Airtable, Figma, Canva, Mailchimp, Pipedrive, monday.com | OAuth app each | mostly light; marketplace listings optional |

**Already no app needed - their hosted MCP server signs in by itself**
(`mcp_oauth`): Notion, Linear, Atlassian (Jira, Confluence), Asana, Sentry,
Stripe, Intercom and a growing list - for these, prefer the official MCP
server over building our own app at all.

**A key is the normal way - nothing to register**: Stripe restricted keys,
Twilio, Sentry tokens, Airtable personal tokens, Mailchimp keys, the web
search and media APIs (Brave, Serper, Tavily, Exa, Pexels). The key stays
the person's; that's fine.

**Gated or expensive - leave until someone needs it**: LinkedIn (partner
programmes), X (paid API tiers), Meta - Facebook, Instagram, WhatsApp (app
review plus business verification).

Rough order after Google: GitHub, Microsoft 365, Slack, then HubSpot,
Salesforce, Zoho, Xero and QuickBooks as the packs that use them (sales,
support, finance) need them.

## Google, step by step

In a Google Cloud project owned by the World Asset Register Google account:

1. **APIs**: enable Gmail (then Calendar, Drive) API.
2. **Branding**: app name "Extremely Autonomous Agents", logo, support email,
   homepage `https://extremely.agency`, privacy policy and terms pages there,
   and `extremely.agency` as an authorised domain - proven in Google Search
   Console with a DNS TXT record (Cloudflare).
3. **Audience**: External, then Publish.
4. **Data access**: add the scopes (below).
5. **Clients**: one, type **Desktop app**.
6. **Verification**: brand verification (days). Sensitive scopes: a reason
   for each and a short screen recording of the sign-in and of what uses them.
   Restricted scopes: also a **CASA** security assessment by an authorised lab,
   **every year**.

Until it's verified: at most 100 people can sign in, and each sees "Google
hasn't verified this app". Fine for a closed beta, not for launch.

### Which scopes (the decision that matters)

| Service | Scope | Google's class | What it means |
|---|---|---|---|
| Gmail | `gmail.modify` (today) | restricted | verification + yearly CASA |
| Gmail | `gmail.send` only | sensitive | no CASA, but agents can't read mail |
| Calendar | `calendar.events` | sensitive | verification, no CASA |
| Drive | `drive.file` | non-sensitive | only files the app made or the person picked |
| Drive | `drive` / `drive.readonly` | restricted | verification + yearly CASA |

Any Gmail scope that reads mail is restricted, so **Gmail as it is means CASA**
- there's no narrower read scope. Recommended: Drive starts on `drive.file`
(covers "write me a report into my Drive" and files the person shares with it),
Calendar on `calendar.events`, and Gmail keeps `gmail.modify` and goes through
CASA, since reading email is what the email agents are for. Moving a scope
later makes everyone sign in again, so pick before launch.

## Cost and time (check current figures)

| | Cost | Time |
|---|---|---|
| Google brand verification | none | days |
| Google sensitive scopes | none | days to weeks |
| Google CASA (restricted) | paid to the lab, yearly | weeks |
| GitHub App | none | an afternoon |
| Microsoft publisher verification | none (Partner Network ID) | days |
| Slack public distribution | none | an afternoon |

## Open decisions

- Gmail: keep reading mail (CASA) or ship send-only first?
- Drive: `drive.file` to start?
- Privacy policy and terms on extremely.agency: needed by Google, Microsoft
  and Slack before any of them verifies us.
