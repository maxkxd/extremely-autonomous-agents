import { discardDraft, draftsForRequest } from '../integrations/index.js';
import { FLEET_ENGINEER } from './agent.js';
import { all, run as exec } from './db.js';
import { abortRun } from './scheduler.js';

// What a deleted agent leaves in the runner's store, settled: nothing it was
// waiting on stays open, and nothing waits on it. Its runs and actions stay,
// so Usage still adds up.
export async function forgetAgentRuns(id: string, now = Date.now()) {
  abortRun(id);
  exec('DELETE FROM bookings WHERE agent_id = ?', id);

  // Its approvals, and the Fleet Engineer's for it (tools going live for it).
  const gone = "status = 'rejected', decided_at = ?, note = 'Its agent was deleted.'";
  exec(`UPDATE approvals SET ${gone} WHERE status = 'pending' AND agent_id = ?`, now, id);
  exec(`UPDATE approvals SET ${gone} WHERE status = 'pending' AND agent_id = ? AND json_extract(args, '$.for_agent') = ?`, now, FLEET_ENGINEER, id);

  // Its open requests, with whatever the Fleet Engineer drafted for them.
  for (const r of all<{ id: number }>("SELECT id FROM requests WHERE agent_id = ? AND status = 'open'", id)) {
    for (const d of draftsForRequest(r.id)) await discardDraft(d).catch(() => {});
    exec("UPDATE requests SET status = 'rejected', answer = 'Its agent was deleted.', answered_at = ?, stage = NULL WHERE id = ?", now, r.id);
  }

  // Work handed to it: closed, so the agent that handed it over hears it wasn't done.
  exec("UPDATE tasks SET status = 'done', result = 'Not done: the agent it was handed to was deleted.', done_at = ? WHERE agent_id = ? AND status = 'open'", now, id);

  exec('DELETE FROM dm WHERE agent_id = ?', id);
  exec('DELETE FROM memories WHERE agent_id = ?', id);
  exec('DELETE FROM agent_state WHERE agent_id = ?', id);
}
