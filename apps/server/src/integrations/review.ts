import { availableModels } from '../models/connections.js';
import { harnessFor } from '../runner/harness.js';
import { adapterFor } from '../runner/providers.js';
import type { Permissions } from './sandbox.js';

// The independent security review of a code plugin (docs/integrations.md): a
// fresh model call, not the engineer that wrote it, told to attack the code.
// It runs before a plugin can be proposed. A serious finding sends it back to
// the engineer; otherwise what it found - and, in plain words, what the code
// can do on this computer - goes on the approval card for a person who may not
// read code. One call to a fast model: about as long as a page load or two.

export type Review = { verdict: 'approve' | 'fix'; canDo: string[]; concerns: { severity: 'high' | 'medium' | 'low'; what: string }[]; fix: string };

const SYSTEM = `You are a security reviewer for code plugins in an AI agency app. A plugin runs on a person's own computer. AI agents call its tools with inputs the agents choose - treat every input as attacker-controlled (an agent may have read a malicious web page or email).

What the sandbox already enforces: files only in the folders the plugin declared (read/write); the network only through kit.fetch, which refuses this computer and its local network; starting programs only if it declared "commands". Once it may start programs, those programs (PowerShell, cmd...) are NOT contained - they can do anything the person can.

Look for:
- Agent inputs reaching commands, scripts, registry, paths or URLs unsafely (string-built shell commands, script injection, path traversal).
- Anything beyond the plugin's stated purpose; hidden or surprising behaviour.
- Destructive or hard-to-undo actions without a guard (deleting, overwriting the person's files, system settings).
- Data leaving the computer: kit.fetch sending file contents, secrets or personal data out.
- Declared permissions broader than the code needs; reading secrets or credentials.
- Programs started with agent-controlled arguments, or downloading and running anything.

Answer with JSON only, no prose around it:
{"verdict":"approve"|"fix","can_do":["..."],"concerns":[{"severity":"high"|"medium"|"low","what":"..."}],"fix":"..."}
- can_do: 2-6 short plain-English lines for someone who can't read code, saying concretely what this can do on their computer (e.g. "Changes your desktop wallpaper", "Saves images in Pictures\\Morning Wallpaper", "Downloads images from public websites"). Include the scary parts plainly.
- verdict "fix" if any concern is high; "fix" names what to change. Otherwise "approve" and fix "".`;

// A quick, capable model the person has connected: an API model if there is one, else their Claude plan.
async function reviewer(): Promise<{ connection: string; model: string } | null> {
  const avail = await availableModels().catch(() => []);
  const prefer: [string, RegExp][] = [
    ['anthropic', /sonnet-5/],
    ['anthropic', /sonnet/],
    ['chatgpt', /./],
    ['openai', /^gpt-5\.\d+$|^gpt-5\.\d+-20/],
    ['google', /pro|flash/],
    ['openrouter', /anthropic\/claude-sonnet|openai\/gpt-5/],
    ['claude-code', /sonnet/],
    ['copilot', /./],
  ];
  for (const [connection, re] of prefer) {
    const model = avail.find(a => a.connection === connection)?.models.find(m => re.test(m));
    if (model) return { connection, model };
  }
  return null;
}

export function parseReview(text: string): Review {
  const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  const r = JSON.parse(json) as Partial<{ verdict: string; can_do: string[]; concerns: { severity: string; what: string }[]; fix: string }>;
  const concerns = (r.concerns ?? []).filter(c => c?.what).map(c => ({ severity: (['high', 'medium', 'low'].includes(c.severity) ? c.severity : 'medium') as Review['concerns'][number]['severity'], what: String(c.what) }));
  return {
    verdict: r.verdict === 'approve' && !concerns.some(c => c.severity === 'high') ? 'approve' : 'fix',
    canDo: (r.can_do ?? []).map(String).filter(Boolean).slice(0, 8),
    concerns,
    fix: String(r.fix ?? ''),
  };
}

export async function reviewPlugin(p: { name: string; yaml: string; code: string; permissions: Permissions }): Promise<Review> {
  const who = await reviewer();
  if (!who) throw new Error("No model is connected that can review the plugin's code. Connect one in Settings -> Connectors.");
  const perms = `Declared permissions - read: ${p.permissions.read.join(', ') || 'none'}; write: ${p.permissions.write.join(', ') || 'none'}; start programs: ${p.permissions.commands ? 'yes' : 'no'}.`;
  const prompt = `Review this plugin, "${p.name}".\n\n${perms}\n\n--- Definition ---\n${p.yaml}\n\n--- Code ---\n${p.code}`;
  let text: string;
  const adapter = adapterFor(who.connection);
  if (adapter) {
    text = (await adapter({ connection: who.connection, model: who.model, system: SYSTEM, messages: [{ role: 'user', text: prompt }], tools: [], maxTokens: 2000 })).text;
  } else {
    const harness = harnessFor(who.connection)!;
    text = (await harness({ model: who.model, system: SYSTEM, opening: prompt, tools: [], call: async () => ({ content: '', error: true }), next: () => null })).text;
  }
  try {
    return parseReview(text);
  } catch {
    return { verdict: 'fix', canDo: [], concerns: [{ severity: 'high', what: "The review couldn't be read, so the plugin wasn't checked." }], fix: 'Propose it again.' };
  }
}
