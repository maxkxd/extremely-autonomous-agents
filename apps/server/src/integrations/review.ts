import { REVIEWER } from '../runner/helpers.js';
import { ask, HelperStopped } from '../runner/quick.js';
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
  const perms = `Declared permissions - read: ${p.permissions.read.join(', ') || 'none'}; write: ${p.permissions.write.join(', ') || 'none'}; start programs: ${p.permissions.commands ? 'yes' : 'no'}.`;
  const prompt = `Review this plugin, "${p.name}".\n\n${perms}\n\n--- Definition ---\n${p.yaml}\n\n--- Code ---\n${p.code}`;
  const text = await ask(REVIEWER, {
    trigger: 'handoff',
    task: `Review the plugin "${p.name}".`,
    system: SYSTEM,
    prompt,
    summary: t => {
      const r = parseReview(t);
      const found = r.concerns.map(c => `(${c.severity}) ${c.what}`).join('; ');
      return r.verdict === 'approve' ? `Reviewed "${p.name}": fine to propose.${found ? ` Noted: ${found}` : ''}` : `Sent "${p.name}" back: ${found || r.fix}`;
    },
  }).catch(e => {
    if (e instanceof HelperStopped) throw new Error("The Security Reviewer is stopped, so plugins can't be proposed. Tell the person on the request: it needs turning back on, on its card on the dashboard.");
    throw e;
  });
  try {
    return parseReview(text);
  } catch {
    return { verdict: 'fix', canDo: [], concerns: [{ severity: 'high', what: "The review couldn't be read, so the plugin wasn't checked." }], fix: 'Propose it again.' };
  }
}
