import { FLEET_ENGINEER } from './agent.js';
import { DOCTOR } from './doctor.js';
import { all, getSetting, one, run as exec, setSetting } from './db.js';
import { abortRun } from './scheduler.js';
import { discardDraft, draftsForRequest } from '../integrations/index.js';
import { dequeue } from '../jobs.js';
import { deletePassword } from './passwords.js';

// What a deleted agent leaves behind is nothing: recreating one with the same
// id or name starts clean. Every row, setting and secret keyed by the agent is
// removed, not just withdrawn.

const SETTINGS_BY_AGENT = ['no_goal_asked', 'resume_at', 'run_days', 'models_moved_off', 'builtin_tool_levels'] as const;

function forgetSetting(id: string, key: string) {
  const all = getSetting<Record<string, unknown>>(key, {});
  if (!all || typeof all !== 'object' || !(id in all)) return;
  delete all[id];
  setSetting(key, all);
}

export async function forgetAgentRuns(id: string, now = Date.now()) {
  abortRun(id);
  dequeue(id);

  // Draft integrations first, before the approvals and requests that point at them go.
  const pendingEngineer = all<{ args: string }>(
    "SELECT args FROM approvals WHERE status = 'pending' AND agent_id = ? AND tool = 'engineer.publish_integration' AND json_extract(args, '$.for_agent') = ?",
    FLEET_ENGINEER,
    id,
  );
  for (const p of pendingEngineer) {
    try {
      const parsed = JSON.parse(p.args) as { integration_id?: string };
      if (parsed.integration_id) {
        await discardDraft(String(parsed.integration_id)).catch(() => false);
      }
    } catch {}
  }

  const openRequests = all<{ id: number }>("SELECT id FROM requests WHERE agent_id = ? AND status = 'open'", id);
  for (const r of openRequests) {
    for (const d of draftsForRequest(r.id)) {
      const otherWaiting = one<{ id: number }>("SELECT id FROM requests WHERE status = 'open' AND agent_id != ? AND waiting_on = ?", id, d);
      if (!otherWaiting) {
        await discardDraft(d).catch(() => false);
      }
    }
  }

  // Work it handed to someone else: close it so that agent hears it isn't needed.
  // Its own tasks are deleted with the rest of its rows below.
  exec(
    "UPDATE tasks SET status = 'done', result = 'Not needed: the agent that handed it over was deleted.', done_at = ?, delivered_at = ? WHERE from_agent = ? AND agent_id != ? AND status = 'open'",
    now,
    now,
    id,
    id,
  );

  for (const row of all<{ id: string }>('SELECT id FROM passwords WHERE agent_id = ?', id)) {
    await deletePassword(row.id);
  }

  exec('DELETE FROM request_messages WHERE request_id IN (SELECT id FROM requests WHERE agent_id = ?)', id);
  exec('DELETE FROM requests WHERE agent_id = ?', id);
  exec('DELETE FROM approvals WHERE agent_id = ?', id);
  exec("DELETE FROM approvals WHERE json_extract(args, '$.for_agent') = ?", id);
  exec("DELETE FROM approvals WHERE json_extract(args, '$.agent_id') = ?", id);
  exec('DELETE FROM tasks WHERE agent_id = ?', id);
  exec('DELETE FROM bookings WHERE agent_id = ?', id);
  exec('DELETE FROM dm WHERE agent_id = ?', id);
  exec('DELETE FROM memories WHERE agent_id = ?', id);
  exec('DELETE FROM tool_health WHERE agent_id = ?', id);
  exec('DELETE FROM action_pace WHERE agent_id = ?', id);
  exec('DELETE FROM actions WHERE agent_id = ?', id);
  exec('DELETE FROM runs WHERE agent_id = ?', id);
  exec('DELETE FROM agent_goals WHERE agent_id = ?', id);
  exec('DELETE FROM agent_pace WHERE agent_id = ?', id);
  exec('DELETE FROM agent_state WHERE agent_id = ?', id);
  exec('DELETE FROM accounts WHERE agent_id = ?', id);

  for (const key of SETTINGS_BY_AGENT) forgetSetting(id, key);
}
