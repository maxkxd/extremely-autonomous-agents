import { matchMembers } from './builder.js';
import { loadPerson, loadProfile, saveProfile, type Person, type Profile } from './org.js';

// Links between the organisation profile's key people and the organisation's
// members in the app, so a key person shows their account and agents know who
// they can reach directly. Decided by a short AI check rather than by name, so
// an owner and a salesperson who are both called Adrian don't get mixed up.
// The server owns the link fields; the app only shows them.

const key = (p: Pick<Person, 'name' | 'role'>) => `${p.name.trim()}|${p.role.trim()}`;
const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

// A save from the app carries people as it last saw them: keep each person's
// link from the stored profile, as long as their name and role haven't changed.
export function keepLinks(prev: Profile | null, next: Profile): Profile {
  const known = new Map((prev?.people ?? []).filter(p => p.matched).map(p => [key(p), p]));
  return {
    ...next,
    people: next.people.map(({ name, role }) => {
      const k = known.get(key({ name, role }));
      return k ? { name, role, member: k.member, matched: k.matched } : { name, role };
    }),
    members_seen: prev?.members_seen,
  };
}

// One check at a time per organisation; a second call waits for the first.
const chains = new Map<string, Promise<unknown>>();

export function linkPeople(org: string, members: string[]): Promise<Profile | null> {
  // An organisation always has a member; no list means the caller didn't say.
  if (!members.length) return loadProfile(org);
  const next = (chains.get(org) ?? Promise.resolve()).catch(() => {}).then(() => run(org, members));
  chains.set(org, next);
  return next;
}

async function run(org: string, members: string[]): Promise<Profile | null> {
  const p = await loadProfile(org);
  if (!p) return null;
  const seen = [...new Set(members)].sort();
  const membersChanged = !same(p.members_seen ?? [], seen);

  // Someone who left the organisation is no longer anyone's account.
  const people: Person[] = p.people.map(x => (x.member && !seen.includes(x.member) ? { name: x.name, role: x.role } : x));
  const decide = people
    .map((x, i) => i)
    .filter(i => {
      const x = people[i];
      return x.name.trim() && (x.matched !== key(x) || (membersChanged && x.member === null));
    });
  if (!decide.length && !membersChanged && same(people.map(x => x.member ?? ''), p.people.map(x => x.member ?? ''))) return p;

  const decided = new Map<number, string | null>();
  if (decide.length && seen.length) {
    const accounts = await Promise.all(seen.map(loadPerson));
    const out = await matchMembers(
      people.map((x, index) => ({ index, name: x.name, role: x.role, member: x.member })),
      decide,
      accounts,
    );
    for (const l of out.links) if (decide.includes(l.index)) decided.set(l.index, l.member && seen.includes(l.member) ? l.member : null);
    // Each member is at most one key person: drop any pick that would double up.
    const taken = new Set(people.filter((x, i) => !decide.includes(i) && x.member).map(x => x.member));
    const picks = [...decided.values()].filter(Boolean);
    for (const [i, m] of decided) if (m && (taken.has(m) || picks.filter(x => x === m).length > 1)) decided.set(i, null);
  }
  for (const i of decide) people[i] = { name: people[i].name, role: people[i].role, member: decided.get(i) ?? null, matched: key(people[i]) };

  // Write onto the latest file, so edits saved while the check ran aren't lost:
  // a person edited meanwhile keeps no link and gets checked next time.
  const latest = (await loadProfile(org)) ?? p;
  const byKey = new Map(people.filter(x => x.matched).map(x => [key(x), x]));
  const out: Profile = {
    ...latest,
    people: latest.people.map(x => {
      const l = byKey.get(key(x));
      return l ? { name: x.name, role: x.role, member: l.member, matched: l.matched } : x.member && !seen.includes(x.member) ? { name: x.name, role: x.role } : x;
    }),
    members_seen: seen,
  };
  await saveProfile(org, out);
  return out;
}
