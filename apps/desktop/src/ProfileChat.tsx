import { useRef, useState } from 'react';
import { BuilderChat } from './BuilderChat';
import { NEW_SESSION, profileOpener, profileTurn, saveProfile, type BuilderSession, type Profile, type Turn } from './builder';

// The organization profile chat (docs/agent-creation.md): a short builder
// conversation that fills in who the organization's agents work for. Opened
// from Settings when an account becomes an organization, and before the first
// agent if an organization has no profile yet.
export function useProfileChat() {
  const [session, setSession] = useState<BuilderSession>(NEW_SESSION);
  const [origin, setOrigin] = useState<DOMRect | null>(null);
  const org = useRef('');
  const draft = useRef<Profile | null>(null);
  const done = useRef<(() => void) | null>(null);

  // orgName: the organization being described. onSaved runs once its profile is saved.
  const start = (orgName: string, from: Element | null | undefined, onSaved: () => void) => {
    org.current = orgName;
    draft.current = null;
    done.current = onSaved;
    setOrigin(from?.getBoundingClientRect() ?? null);
    setSession({ ...NEW_SESSION, phase: 'chat', open: true, turns: [{ role: 'builder', text: profileOpener(orgName) }] });
  };

  const ask = async (turns: Turn[]) => {
    setSession(s => ({ ...s, thinking: true, error: null }));
    try {
      const r = await profileTurn(org.current, turns);
      draft.current = r.profile;
      setSession(s => ({
        ...s,
        thinking: false,
        turns: [...s.turns, { role: 'builder', text: r.reply }],
        confidence: r.confidence,
        ready: r.ready,
      }));
    } catch (e) {
      setSession(s => ({ ...s, thinking: false, error: (e as Error).message }));
    }
  };

  const reply = (text: string) => {
    const turns: Turn[] = [...session.turns, { role: 'person', text }];
    setSession(s => ({ ...s, turns, ready: false }));
    ask(turns);
  };

  const save = async () => {
    if (!draft.current) return;
    setSession(s => ({ ...s, phase: 'building', error: null }));
    try {
      await saveProfile(org.current, draft.current);
      setSession(NEW_SESSION);
      const next = done.current;
      done.current = null;
      next?.();
    } catch (e) {
      setSession(s => ({ ...s, phase: 'chat', error: (e as Error).message }));
    }
  };

  const element =
    session.open && origin ? (
      <BuilderChat
        origin={origin}
        session={session}
        title="Your organization"
        buildLabel="Save and continue"
        buildingText="Saving your organization"
        busyLabel="Saving"
        onReply={reply}
        onRetry={() => ask(session.turns)}
        onBuild={save}
        onClose={() => {
          done.current = null;
          setSession(NEW_SESSION);
        }}
      />
    ) : null;

  return { start, element };
}
