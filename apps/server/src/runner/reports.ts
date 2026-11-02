import { getSetting, setSetting } from './db.js';

// Where agents' reports go by default, agency-wide (decided 2026-11-02). The first
// place the person names for any agent's reports becomes it; later agents use it
// without asking, and any one agent can still be sent somewhere else. The Agency
// Engineer keeps it: it moves to a place that suits everything better (an "Agent
// stuff" folder), never to one the person named for a single agent. "Kept here in
// the app" is never the default - the app's DMs are for watching, not reading reports.

export type ReportDefault = { where: string; tool: string; why: string; at: number };

const KEY = 'report_default';
export const reportDefault = () => getSetting<ReportDefault | null>(KEY, null);

export function setReportDefault(where: string, tool: string, why: string, now = Date.now()): ReportDefault {
  const w = where.trim();
  const t = tool.trim();
  if (!w) throw new Error('Say where: the folder\'s full path, "email to the owner", the Drive folder or Notion page.');
  if (!/^[a-z0-9_-]+\.[a-z0-9_-]+$/i.test(t)) throw new Error('Give the tool that delivers there (server.tool), e.g. computer_files.write_file or gmail.send_to_me.');
  if (/\b(in|kept|stays?) (here )?in the app\b|\bdm\b/i.test(w)) throw new Error('"Kept in the app" is never the default: only a place of theirs is.');
  const d = { where: w.slice(0, 300), tool: t, why: why.trim().slice(0, 300), at: now };
  setSetting(KEY, d);
  return d;
}

// One line for a prompt: the builder's and the Agency Engineer's.
export function reportDefaultForPrompt(): string {
  const d = reportDefault();
  return d
    ? `The agency's default place for reports: ${d.where} (delivered with ${d.tool}). An agent that reports goes there unless the person names another place for it - don't ask them where.`
    : "The agency has no default place for reports yet: the first place the person names for an agent's reports becomes it.";
}
