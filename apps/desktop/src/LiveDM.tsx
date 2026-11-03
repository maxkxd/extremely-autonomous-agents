import { useEffect, useRef, useState } from 'react';
import { AgentDM, type StampedEntry } from './AgentDM';
import { getAgency, getDm, getLiveAgents, sendDm } from './builder';
import type { Resolution } from './Approvals';

// A real agent's DM channel (docs/agent-dms.md): its run posts and your
// messages, from the runner. Sending a message books a run to answer it; the
// channel shows it running until that run's reply lands.
export function LiveDM({
  agentId,
  approvalOutcomes,
  onOpenDashboard,
  onStopped,
}: {
  agentId: string;
  approvalOutcomes: Record<string, Resolution>;
  onOpenDashboard: () => void;
  onStopped: (stopped: boolean) => void; // for the page header's Stopped pill
}) {
  const [entries, setEntries] = useState<StampedEntry[]>([]);
  // Messages the server didn't take (it's stopped), with its reply: kept on screen,
  // where they used to vanish at the next refresh.
  const [held, setHeld] = useState<StampedEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [waitingSince, setWaitingSince] = useState<number | null>(null);
  // Stopped (it, or the whole agency): a message waits, so the channel says so
  // instead of showing it running (it showed "running…" for ten minutes).
  const [stopped, setStopped] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
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
          ([agents, agency]) => {
            if (stop) return;
            const now = agency.state === 'stopped' || agents[agentId]?.state === 'stopped';
            setStopped(now);
            onStopped(now);
          },
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
  useEffect(() => {
    setWaitingSince(null);
    setSendError(null);
  }, [agentId]);

  const send = (text: string) => {
    const at = Date.now();
    const mine: StampedEntry = { kind: 'you', minutesAgo: 0, text, at };
    const reply: StampedEntry = { kind: 'stopped', minutesAgo: 0, at: at + 1 };
    setSendError(null);
    // Stopped: it "sends", and the agent says it's stopped and where to resume it.
    if (stopped) return setHeld(h => [...h, mine, reply]);
    setEntries(prev => [...prev, mine]);
    setWaitingSince(at);
    sendDm(agentId, text).catch(e => {
      setWaitingSince(null);
      setEntries(prev => prev.filter(x => x !== mine)); // held instead, below
      const why = (e as Error).message;
      // Refused because it's stopped (it was stopped a moment ago): the same reply.
      if (/stopped/i.test(why)) return setHeld(h => [...h, mine, reply]);
      // Anything else (not yours to message...): kept, and why.
      setHeld(h => [...h, mine]);
      setSendError(why);
    });
  };
  const shown = held.length ? [...entries, ...held].sort((a, b) => a.at - b.at) : entries;

  return (
    <AgentDM
      agentId={agentId}
      entries={shown}
      loading={!loaded}
      thinking={waitingSince != null && !stopped}
      stopped={stopped}
      sendError={sendError}
      onSend={send}
      approvalOutcomes={approvalOutcomes}
      onOpenDashboard={onOpenDashboard}
    />
  );
}
