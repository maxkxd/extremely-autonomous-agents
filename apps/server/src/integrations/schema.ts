import { z } from 'zod/v4';

// What an integration is (docs/integrations.md): a definition file, so the
// Fleet Engineer can add one without writing code.
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
    scopes: z.array(z.string()).min(1),
    params: z.record(z.string(), z.string()).optional(), // extra authorize params (Google: access_type=offline)
    client_url: z.string().url().optional(), // where to make the OAuth client
    client_help: z.string().optional(), // how to make it, in steps
  }),
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
    url: z.string().url(),
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
