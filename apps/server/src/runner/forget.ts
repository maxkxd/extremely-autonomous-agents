import { FLEET_ENGINEER } from './agent.js';
import { DOCTOR } from './doctor.js';
import { all, one, run as exec } from './db.js';
import { abortRun } from './scheduler.js';
import { discardDraft, draftsForRequest } from '../integrations/index.js';

// What a deleted agent leaves in the runner's store, settled: nothing it was
// waiting on stays open, and nothing waits on it. Its runs and actions stay,
// so Usage still adds up.
export async function forgetAgentRuns(id: string, now = Date.now()) {
  abortRun(id);
  exec('DELETE FROM bookings WHERE agent_id = ?', id);

  // Any draft integrations for the agent's pending approvals: discard them before rejecting.
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

  // Any open requests of this agent: if they drafted an integration, discard it unless another open request is waiting on it.
  const openRequests = all<{ id: number }>("SELECT id FROM requests WHERE agent_id = ? AND status = 'open'", id);
  for (const r of openRequests) {
    for (const d of draftsForRequest(r.id)) {
      const otherWaiting = one<{ id: number }>("SELECT id FROM requests WHERE status = 'open' AND agent_id != ? AND waiting_on = ?", id, d);
      if (!otherWaiting) {
        await discardDraft(d).catch(() => false);
      }
    }
  }

  // Its approvals, and the Agency Engineer's for it (tools going live for it).
  const gone = "status = 'rejected', decided_at = ?, note = 'Its agent was deleted.'";
  exec(`UPDATE approvals SET ${gone} WHERE status = 'pending' AND agent_id = ?`, now, id);
  exec(`UPDATE approvals SET ${gone} WHERE status = 'pending' AND agent_id = ? AND json_extract(args, '$.for_agent') = ?`, now, FLEET_ENGINEER, id);
  // And the Agency Doctor's rule for it, if one's waiting.
  exec(`UPDATE approvals SET ${gone} WHERE status = 'pending' AND agent_id = ? AND json_extract(args, '$.agent_id') = ?`, now, DOCTOR, id);

  // Its open requests: withdrawn - marked told, so an agent remade under the same id doesn't hear about them.
  exec("UPDATE requests SET status = 'withdrawn', answer = 'Its agent was deleted.', answered_at = ?, delivered_at = ?, stage = NULL WHERE agent_id = ? AND status = 'open'", now, now, id);
  exec("UPDATE requests SET delivered_at = ? WHERE agent_id = ? AND status != 'open' AND delivered_at IS NULL", now, id);

  // Work handed to it: closed, so the agent that handed it over hears it wasn't done.
  exec("UPDATE tasks SET status = 'done', result = 'Not done: the agent it was handed to was deleted.', done_at = ? WHERE agent_id = ? AND status = 'open'", now, id);
  // Work it handed to others: nobody is left to hear the result, so they stop on it.
  exec("UPDATE tasks SET status = 'done', result = 'Not needed: the agent that handed it over was deleted.', done_at = ?, delivered_at = ? WHERE from_agent = ? AND status = 'open'", now, now, id);

  exec('DELETE FROM dm WHERE agent_id = ?', id);
  exec('DELETE FROM memories WHERE agent_id = ?', id);
  exec('DELETE FROM agent_state WHERE agent_id = ?', id);
}
