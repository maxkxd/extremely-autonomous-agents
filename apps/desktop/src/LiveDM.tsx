import { useEffect, useRef, useState } from 'react';
import { AgentDM, type StampedEntry } from './AgentDM';
import { getAgency, getDm, getLiveAgents, sendDm } from './builder';
import type { Resolution } from './Approvals';

// A real agent's DM channel (docs/agent-dms.md): its run posts and your
// messages, from the runner. Sending a message books a run to answer it; the
// channel shows it running until that run's reply lands.
export function LiveDM({ agentId, approvalOutcomes }: { agentId: string; approvalOutcomes: Record<string, Resolution> }) {
  const [entries, setEntries] = useState<StampedEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [waitingSince, setWaitingSince] = useState<number | null>(null);
  // Stopped (it, or the whole agency): a message waits, so the channel says so
  // instead of showing it running (it showed "running…" for ten minutes).
  const [stopped, setStopped] = useState(false);
  const waiting = useRef<number | null>(null);
  waiting.current = waitingSince;

  useEffect(() => {
    let stop = false;
    const load = async () => {
      try {
        const list = await getDm(agentId);
        if (stop) return;
        setEntries(list);
        setLoaded(true);
        Promise.all([getLiveAgents(1), getAgency()]).then(
          ([agents, agency]) => !stop && setStopped(agency.state === 'stopped' || agents[agentId]?.state === 'stopped'),
          () => {},
        );
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

  return <AgentDM agentId={agentId} entries={entries} loading={!loaded} thinking={waitingSince != null && !stopped} stopped={stopped} onSend={send} approvalOutcomes={approvalOutcomes} />;
}
