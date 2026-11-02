import { realName } from './agent.js';
import { getSetting, setSetting } from './db.js';

// Where an agent's reports go by default (decided 2026-11-02): each person has their
// own - in an organization, Sam's go to Sam's folder and Jo is asked once for Jo's
// place, since a folder on the host's computer is one Jo can't open. The first place
// a person names for any of their agents' reports becomes theirs; their later agents
// use it without asking, and any one agent can still be sent somewhere else. The
// Agency Engineer keeps them: one moves to a place that suits all that person's
// reports better (an "Agent stuff" folder), never to one named for a single agent.
// "Kept here in the app" is never a default - the DMs are for watching, not reading.

export type ReportDefault = { where: string; tool: string; why: string; at: number };

const KEY = 'report_defaults';
const SINGLE = 'report_default'; // before there was one each: it was the host's

// Whose: the person named, else the agency's own person (the host).
const whose = (person?: string | null) => (realName(person) ?? getSetting<string | null>('host_person', null) ?? 'the agency').trim();
const keyOf = (person?: string | null) => whose(person).toLowerCase();

function defaults(): Record<string, ReportDefault> {
  const each = getSetting<Record<string, ReportDefault>>(KEY, {});
  const single = getSetting<ReportDefault | null>(SINGLE, null);
  return single && !Object.keys(each).length ? { [keyOf(null)]: single } : each;
}

export const reportDefault = (person?: string | null) => defaults()[keyOf(person)] ?? null;

export function setReportDefault(where: string, tool: string, why: string, person?: string | null, now = Date.now()): ReportDefault {
  const w = where.trim();
  const t = tool.trim();
  if (!w) throw new Error('Say where: the folder\'s full path, "email to the owner", the Drive folder or Notion page.');
  if (!/^[a-z0-9_-]+\.[a-z0-9_-]+$/i.test(t)) throw new Error('Give the tool that delivers there (server.tool), e.g. computer_files.write_file or gmail.send_to_me.');
  if (/\b(in|kept|stays?) (here )?in the app\b|\bdm\b/i.test(w)) throw new Error('"Kept in the app" is never a default: only a place of theirs is.');
  const d = { where: w.slice(0, 300), tool: t, why: why.trim().slice(0, 300), at: now };
  setSetting(KEY, { ...defaults(), [keyOf(person)]: d });
  return d;
}

// For the builder, talking to one person.
export function reportDefaultForPrompt(person?: string | null): string {
  const d = reportDefault(person);
  return d
    ? `${whose(person)}'s default place for reports: ${d.where} (delivered with ${d.tool}). An agent of theirs that reports goes there unless they name another place for it - don't ask them where.`
    : `${whose(person)} has no default place for reports yet: the first place they name for an agent's reports becomes it.`;
}

// For the Agency Engineer: everyone's.
export function reportDefaultsForPrompt(): string {
  const all = Object.values(defaults()).length ? Object.entries(defaults()) : [];
  if (!all.length) return 'Default places for reports: none yet - the first place a person names for their reports becomes theirs.';
  return `Default places for reports, by person (an agent's owner's applies to it): ${all.map(([who, d]) => `${who}: ${d.where} (${d.tool})`).join('; ')}. Anyone not listed has none yet.`;
}
