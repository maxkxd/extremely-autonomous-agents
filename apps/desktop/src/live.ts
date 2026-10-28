import { AGENTS } from './data';
import type { Outcome } from './FlashCount';

// A decision someone (or the clock) made on an approval, anywhere in the org.
export type DecisionEvent = { agentId: string; outcome: Outcome; by: string | null };

// THE hook point for real-time activity: subscribe to approvals being approved,
// rejected or expiring - by anyone - so the dashboard can show people working
// live. Returns an unsubscribe function.
//
// PLACEHOLDER: there is no backend yet, so this runs a SIMULATOR that invents a
// decision every 6-14 seconds. Replace its body with the real server stream
// (websocket / SSE / Supabase channel...) and nothing else needs to change.
// Turn the simulator off with ?nolive in the URL.
export function subscribeToDecisions(onEvent: (e: DecisionEvent) => void): () => void {
  if (new URLSearchParams(window.location.search).has('nolive')) return () => {};

  let timer: number | undefined;
  const next = () => {
    timer = window.setTimeout(() => {
      const agent = AGENTS[Math.floor(Math.random() * AGENTS.length)];
      const roll = Math.random();
      const outcome: Outcome = roll < 0.7 ? 'approved' : roll < 0.9 ? 'rejected' : 'expired';
      onEvent({ agentId: agent.id, outcome, by: outcome === 'expired' ? null : agent.owner });
      next();
    }, 6000 + Math.random() * 8000);
  };
  next();
  return () => window.clearTimeout(timer);
}
