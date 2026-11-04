import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DATA, readMeta, slug } from '../files.js';
import { isAdminRole, type Role } from '../access.js';
import { FLEET_ENGINEER } from './agent.js';
import { all } from './db.js';

// An agent's Charter, rewritten whole (by the Agency Engineer or the Agency
// Doctor): the one it replaces is kept, so a change a person regrets can be put
// back - they ask in a chat and the Engineer restores it. The last few only.
export const KEEP_VERSIONS = 10;
const versionsDir = (agentId: string) => join(DATA, slug(agentId), 'charter-versions');
const charterFile = (agentId: string) => join(DATA, slug(agentId), 'CHARTER.md');

export type CharterVersion = { id: string; at: number };

export async function writeCharter(agentId: string, charter: string, now = Date.now()) {
  const before = await readFile(charterFile(agentId), 'utf8').catch(() => null);
  if (before !== null && before.trim() !== charter.trim()) {
    await mkdir(versionsDir(agentId), { recursive: true });
    await writeFile(join(versionsDir(agentId), `${now}.md`), before);
    for (const old of (await charterVersions(agentId)).slice(KEEP_VERSIONS)) await rm(join(versionsDir(agentId), `${old.id}.md`), { force: true });
  }
  await writeFile(charterFile(agentId), `${charter.trim()}\n`);
}

// Newest first: each one the Charter was before a rewrite, by when it was replaced.
export async function charterVersions(agentId: string): Promise<CharterVersion[]> {
  const names = await readdir(versionsDir(agentId)).catch(() => [] as string[]);
  return names
    .filter(n => /^\d+\.md$/.test(n))
    .map(n => ({ id: n.slice(0, -3), at: Number(n.slice(0, -3)) }))
    .sort((a, b) => b.at - a.at);
}

export async function readCharterVersion(agentId: string, id: string): Promise<string> {
  if (!/^\d+$/.test(id)) throw new Error('version is one of the ids read_agent lists.');
  const text = await readFile(join(versionsDir(agentId), `${id}.md`), 'utf8').catch(() => null);
  if (text === null) throw new Error(`No saved version ${id}. engineer.read_agent lists them.`);
  return text;
}

// Whoever wrote last in the Agency Engineer's chat, and whether they may change
// this agent's instructions: its maker, or an owner or admin. A person asks in
// the chat; the Engineer acts for them, so the check is on them.
// person: whose message the run answers (the Engineer keeps one chat per person).
export async function askerMayChange(agentId: string, person: string | null = null): Promise<{ ok: true; by: string } | { ok: false; why: string }> {
  const last = all<{ body: string }>(
    "SELECT body FROM dm WHERE agent_id = ? AND kind = 'you' AND (? IS NULL OR person_id = ?) ORDER BY at DESC, id DESC LIMIT 1",
    FLEET_ENGINEER,
    person,
    person,
  )[0];
  if (!last) return { ok: false, why: 'Only a person asking in your chat (or a request) can change an agent\'s instructions.' };
  const b = JSON.parse(last.body) as { by?: string; byId?: string; role?: Role };
  const meta = await readMeta(agentId);
  if (!meta) return { ok: false, why: `No agent "${agentId}".` };
  // The host's own person (no account) owns everything here.
  if (!b.byId || b.byId === 'local' || isAdminRole(b.role) || (meta.ownerId && meta.ownerId === b.byId)) return { ok: true, by: b.by ?? 'The person' };
  return { ok: false, why: `${b.by ?? 'They'} didn't make ${meta.name}, and isn't an admin, so its instructions aren't theirs to change. Say so, and that ${meta.owner ?? 'its maker'} or an admin can ask.` };
}
