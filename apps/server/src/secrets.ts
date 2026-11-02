// A key or password pasted into a chat (a DM, a request reply, the builder) is
// taken out before it's stored or sent to any model: it would otherwise sit in
// the database in plain text, go to the AI provider, and could end up in an
// agent's memory, files or pull requests. Keys go in Settings > Connectors,
// where they're encrypted - the note left in its place says so, and the agent
// reading it tells the person.

const NOTE = "[key taken out - it wasn't saved or sent anywhere; keys go in Settings > Connectors, never in a chat]";

// Shapes no ordinary sentence has: providers' key prefixes, tokens, key files.
const SHAPES: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-ant-[A-Za-z0-9_-]{16,}/g,
  /\bsk-(?:proj-|svcacct-|or-v1-|or-)?[A-Za-z0-9_-]{20,}/g,
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g,
  /\bwhsec_[A-Za-z0-9]{16,}/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\bxai-[A-Za-z0-9]{20,}/g,
  /\bgsk_[A-Za-z0-9]{20,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{30,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b1000\.[a-f0-9]{32}\.[a-f0-9]{32}\b/g, // Zoho tokens
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWTs
];
// "password: hunter22", "api_key = abc123...": the value goes, the label stays.
const LABELLED = /\b(password|passwd|pwd|passcode|secret|client[_ -]?secret|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|token)(\s*(?:is|:|=)\s*)["']?[^\s"']{6,}["']?/gi;

export function scrubSecrets(text: string): { text: string; removed: boolean } {
  let out = text;
  for (const re of SHAPES) out = out.replace(re, NOTE);
  out = out.replace(LABELLED, (_m, label: string, sep: string) => `${label}${sep}${NOTE}`);
  return { text: out, removed: out !== text };
}

export const scrub = (text: string) => scrubSecrets(text).text;
