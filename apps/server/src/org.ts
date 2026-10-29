import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DATA_DIR } from './paths.js';

// The organisation profile (docs/agent-creation.md): who every agent works
// for. Filled in by a short builder chat the first time someone adds an agent,
// and added to as the builder learns more. One per organisation.

// A key person may also be a member of the organisation in the app (links.ts).
// The server owns both link fields: member is the account's username, or null
// once checked and none of the members is them; matched is the name and role
// that check was made for, so an edit gets checked again.
export type Person = { name: string; role: string; member?: string | null; matched?: string };
export type Profile = {
  name: string;
  what_it_does: string;
  customers: string;
  offering: string;
  voice: string;
  people: Person[];
  notes: string[];
  members_seen?: string[]; // the members the last check was made against
};

const DIR = join(DATA_DIR, 'orgs');
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

// me: the account you're talking to, so its own entry says so.
export function profileForPrompt(p: Profile, me?: string): string {
  const person = (x: Person) =>
    `- ${x.name}: ${x.role}` +
    (x.member === me && me ? ' (the person you are talking to)' : x.member ? ` (has an account in the app, so Requests and Approvals can go to them directly)` : '');
  return [
    `Organisation: ${p.name}`,
    `What it does: ${p.what_it_does}`,
    `Customers: ${p.customers}`,
    `What it sells or offers: ${p.offering}`,
    `Voice: ${p.voice}`,
    p.people.length ? `People:\n${p.people.map(person).join('\n')}` : '',
    p.notes.length ? `Also known:\n${p.notes.map(n => `- ${n}`).join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

// --- The person: one per account, organisation or not ---

export type PersonProfile = {
  name: string; // the account's username
  full_name?: string;
  call_me?: string; // what agents should call them
  email: string;
  role: string; // what they do, in their own words
  about: string; // how they work, what they care about
  notes: string[]; // learned over time
};

const PEOPLE = join(DATA_DIR, 'people');
const personFile = (name: string) => join(PEOPLE, `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'me'}.json`);

export async function loadPerson(name: string): Promise<PersonProfile> {
  try {
    return JSON.parse(await readFile(personFile(name), 'utf8')) as PersonProfile;
  } catch {
    return { name, email: '', role: '', about: '', notes: [] };
  }
}

export async function savePerson(p: PersonProfile) {
  await mkdir(PEOPLE, { recursive: true });
  await writeFile(personFile(p.name), JSON.stringify(p, null, 2) + '\n');
}

export async function addPersonNotes(name: string, notes: string[]) {
  const p = await loadPerson(name);
  const fresh = notes.map(n => n.trim()).filter(n => n && !p.notes.includes(n));
  if (fresh.length) await savePerson({ ...p, notes: [...p.notes, ...fresh] });
}

export function personForPrompt(p: PersonProfile): string {
  return [
    `Name: ${p.full_name || p.name}`,
    p.call_me && `Call them: ${p.call_me}`,
    p.role && `Role: ${p.role}`,
    p.email && `Email: ${p.email}`,
    p.about && `About them: ${p.about}`,
    p.notes.length ? `Also known:\n${p.notes.map(n => `- ${n}`).join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}
