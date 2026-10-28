import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The organisation profile (docs/agent-creation.md): who every agent works
// for. Filled in by a short builder chat the first time someone adds an agent,
// and added to as the builder learns more. One per organisation.

export type Person = { name: string; role: string };
export type Profile = {
  name: string;
  what_it_does: string;
  customers: string;
  offering: string;
  voice: string;
  people: Person[];
  notes: string[];
};

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'orgs');
const file = (org: string) => join(DIR, `${org.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'org'}.json`);

export async function loadProfile(org: string): Promise<Profile | null> {
  try {
    return JSON.parse(await readFile(file(org), 'utf8')) as Profile;
  } catch {
    return null;
  }
}

export async function saveProfile(org: string, profile: Profile) {
  await mkdir(DIR, { recursive: true });
  await writeFile(file(org), JSON.stringify(profile, null, 2) + '\n');
}

// Facts the builder learned about the organisation in a conversation.
export async function addNotes(org: string, notes: string[]) {
  const p = await loadProfile(org);
  if (!p || !notes.length) return;
  const fresh = notes.map(n => n.trim()).filter(n => n && !p.notes.includes(n));
  if (fresh.length) await saveProfile(org, { ...p, notes: [...p.notes, ...fresh] });
}

export function profileForPrompt(p: Profile): string {
  return [
    `Organisation: ${p.name}`,
    `What it does: ${p.what_it_does}`,
    `Customers: ${p.customers}`,
    `What it sells or offers: ${p.offering}`,
    `Voice: ${p.voice}`,
    p.people.length ? `People:\n${p.people.map(x => `- ${x.name}: ${x.role}`).join('\n')}` : '',
    p.notes.length ? `Also known:\n${p.notes.map(n => `- ${n}`).join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}
