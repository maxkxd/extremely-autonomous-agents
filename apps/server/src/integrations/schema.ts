import { z } from 'zod/v4';

// What an integration is (docs/integrations.md): a definition file, so the
// Agency Engineer can add one without writing code.
//
//   kind: http - its tools are HTTP calls: an address, the inputs, how the
//                key is sent, and what to keep from the answer
//   kind: mcp  - a remote MCP server: its address and how to sign in; its
//                tools are discovered from it
//   kind: code - tools written in code (integrations/modules/), for services
//                whose calls need more than a request template (Gmail builds
//                and decodes email). The same contract as code plugins.
//
// A tool either provides one of the agency's standard tools (web.web_search:
// several integrations can, and agents use whichever is connected) or is the
// integration's own (zoho.create_lead).

const Tier = z.enum(['T0', 'T1', 'T2']);

export const Auth = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }),
  // The key in a header (with an optional prefix like "Bearer ") or in the query.
  z.object({ type: z.literal('api_key'), header: z.string().optional(), query: z.string().optional(), prefix: z.string().optional() }),
  z.object({ type: z.literal('bearer') }),
  // Sign in with the service (OAuth 2, authorization code with PKCE). The
  // person brings their own OAuth client (id and secret, made at client_url);
  // the tokens it returns are kept in the vault and refreshed as needed.
  z.object({
    type: z.literal('oauth2'),
    authorize_url: z.string().url().startsWith('https://'),
    token_url: z.string().url().startsWith('https://'),
    revoke_url: z.string().url().startsWith('https://').optional(), // ends the sign-in on Disconnect
    resource: z.string().optional(), // the resource the tokens are for (RFC 8707), sent with token requests
    scopes: z.array(z.string()).min(1),
    params: z.record(z.string(), z.string()).optional(), // extra authorize params (Google: access_type=offline)
    client_url: z.string().url().optional(), // where to make the OAuth client
    client_help: z.string().optional(), // how to make it, in steps
  }),
  // A remote MCP server's own sign-in (the MCP authorization spec): found and
  // registered with when the person signs in - no OAuth client to make.
  z.object({ type: z.literal('mcp_oauth') }),
]);

const Request = z.object({
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('GET'),
  path: z.string(), // appended to base_url; may hold {{input}} placeholders
  query: z.record(z.string(), z.unknown()).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.unknown().optional(), // JSON template
});

const Response = z
  .object({
    items: z.string().optional(), // dot path to the list in the answer
    fields: z.record(z.string(), z.string()).optional(), // per item: output name -> dot path
    pick: z.string().optional(), // dot path to keep, when it isn't a list
    max_items: z.number().optional(),
  })
  .optional();

// An event (docs/events.md): something happening at the service that wakes the
// agents subscribed to it - a new Sentry issue, a ticket, an alarm. Detected by
// polling the service's API for new items, or pushed by the service to a
// webhook address, or both. Each item is told to the agent once.
export const EventDef = z
  .object({
    id: z.string().regex(/^[a-z0-9_-]+\.[a-z0-9_]+$/, 'server.event, lowercase'),
    description: z.string(), // what happened, for the agent and the person
    // Polling: a request like a tool's (base_url: the integration's, unless given),
    // the list of items in the answer, each one's id, and what the agent sees of it.
    poll: z
      .object({
        base_url: z.string().url().optional(),
        request: Request,
        items: z.string().default(''), // dot path to the list; empty: the answer is the list
        id: z.string(), // dot path in an item to its unique id
        fields: z.record(z.string(), z.string()).optional(), // per item: name -> dot path
        every_minutes: z.number().min(1).max(1440).default(5),
      })
      .optional(),
    // Webhooks: the service posts to the agency's address for this event.
    webhook: z
      .object({
        items: z.string().optional(), // dot path to a list in the body, when one post carries several
        id: z.string().optional(), // dot path to an item's id (else the whole post is one new item)
        fields: z.record(z.string(), z.string()).optional(),
        // Signed posts (Sentry, GitHub, Stripe...): HMAC of the raw body with the
        // signing secret the person pastes in Settings, in this header.
        signature: z
          .object({
            header: z.string(),
            algorithm: z.enum(['sha256', 'sha1']).default('sha256'),
            prefix: z.string().optional(), // e.g. "sha256="
            encoding: z.enum(['hex', 'base64']).default('hex'),
          })
          .optional(),
        secret_help: z.string().optional(), // where the person finds the signing secret
      })
      .optional(),
    setup_help: z.string().optional(), // for webhooks: where in the service to paste the address
  })
  .refine(e => e.poll || e.webhook, 'An event needs poll, webhook, or both.');

export const HttpTool = z.object({
  id: z.string().regex(/^[a-z0-9_-]+\.[a-z0-9_]+$/, 'server.tool, lowercase'),
  tier: Tier,
  description: z.string(),
  input: z.record(z.string(), z.unknown()), // JSON Schema
  request: Request,
  response: Response,
});

export const Integration = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('http'),
    id: z.string().regex(/^[a-z0-9-]+$/),
    name: z.string(),
    what: z.string(),
    key_url: z.string().optional(),
    key_help: z.string().optional(), // what the key needs (permissions), shown by its field
    auth: Auth,
    events: z.array(EventDef).optional(),
    base_url: z.string().url(),
    test: z.object({ tool: z.string(), args: z.record(z.string(), z.unknown()) }),
    tools: z.array(HttpTool).min(1),
  }),
  z.object({
    kind: z.literal('mcp'),
    id: z.string().regex(/^[a-z0-9-]+$/),
    name: z.string(),
    what: z.string(),
    key_url: z.string().optional(),
    key_help: z.string().optional(), // what the key needs (permissions), shown by its field
    auth: Auth,
    events: z.array(EventDef).optional(),
    // Where it is: an address, or - on this computer - a program to start
    // (command, e.g. ["npx", "-y", "@modelcontextprotocol/server-filesystem", "C:/notes"]).
    // local: the address is on this computer or its network. Only a person adds
    // either (Settings); they run with that person's permissions.
    url: z.string().url().optional(),
    command: z.array(z.string().min(1)).min(1).optional(),
    env: z.record(z.string(), z.string()).optional(),
    local: z.boolean().optional(),
    tiers: z.record(z.string(), Tier).optional(), // overrides for discovered tools
  }),
  z.object({
    kind: z.literal('code'),
    id: z.string().regex(/^[a-z0-9-]+$/),
    name: z.string(),
    what: z.string(),
    key_url: z.string().optional(),
    key_help: z.string().optional(), // what the key needs (permissions), shown by its field
    auth: Auth,
    events: z.array(EventDef).optional(),
    module: z.string().regex(/^[a-z0-9-]+$/), // integrations/modules/<module>.ts, or a plugin
    // A plugin's sandbox (sandbox.ts): the folders it reads and writes (absolute,
    // or ~/...), and whether it may start programs. Nothing else is allowed.
    permissions: z
      .object({ read: z.array(z.string()).optional(), write: z.array(z.string()).optional(), commands: z.boolean().optional() })
      .optional(),
    test: z.object({ tool: z.string(), args: z.record(z.string(), z.unknown()) }),
  }),
]);

export type Integration = z.infer<typeof Integration>;
export type HttpIntegration = Extract<Integration, { kind: 'http' }>;
export type McpIntegration = Extract<Integration, { kind: 'mcp' }>;
export type CodeIntegration = Extract<Integration, { kind: 'code' }>;
export type OAuthDef = Extract<AuthDef, { type: 'oauth2' }>;
export type HttpToolDef = z.infer<typeof HttpTool>;
export type AuthDef = z.infer<typeof Auth>;
export type EventDefT = z.infer<typeof EventDef>;
export type RequestDef = z.infer<typeof Request>;
