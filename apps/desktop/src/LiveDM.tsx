import { useEffect, useRef, useState } from 'react';
import { AgentDM, type StampedEntry } from './AgentDM';
import { getDm, sendDm } from './builder';
import type { Resolution } from './Approvals';

// A real agent's DM channel (docs/agent-dms.md): its run posts and your
// messages, from the runner. Sending a message books a run to answer it; the
// channel shows it running until that run's reply lands.
export function LiveDM({ agentId, approvalOutcomes }: { agentId: string; approvalOutcomes: Record<string, Resolution> }) {
  const [entries, setEntries] = useState<StampedEntry[]>([]);
  const [waitingSince, setWaitingSince] = useState<number | null>(null);
  const waiting = useRef<number | null>(null);
  waiting.current = waitingSince;

  useEffect(() => {
    let stop = false;
    const load = async () => {
      try {
        const list = await getDm(agentId);
        if (stop) return;
        setEntries(list);
        // The answer to your message has landed.
        const since = waiting.current;
        if (since && list.some(e => e.kind === 'run' && e.at >= since)) setWaitingSince(null);
      } catch {
        // server down: try again next tick
      }
    };
    load();
    const t = window.setInterval(load, 3000);
    return () => {
      stop = true;
      window.clearInterval(t);
    };
  }, [agentId]);
  useEffect(() => setWaitingSince(null), [agentId]);

  const send = (text: string) => {
    const at = Date.now();
    setEntries(prev => [...prev, { kind: 'you', minutesAgo: 0, text, at }]);
    setWaitingSince(at);
    sendDm(agentId, text).catch(() => setWaitingSince(null));
  };

  return <AgentDM agentId={agentId} entries={entries} thinking={waitingSince != null} onSend={send} approvalOutcomes={approvalOutcomes} />;
}
