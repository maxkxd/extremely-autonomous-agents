import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowUp, Plus, Sparkles } from 'lucide-react';
import { AGENT_PACKS, type AgentPack } from './packs';
import { DEPARTMENT_ICON } from './Sidebar';
import { BuilderChat } from './BuilderChat';
import {
  NEW_SESSION,
  PROFILE_OPENER,
  addPack,
  buildAgent,
  getProfile,
  matchPack,
  nextTurn,
  profileTurn,
  saveProfile,
  type BuilderSession,
  type Built,
  type Profile,
  type Turn,
} from './builder';

// "Customize your own agent" always takes the last slot of the top row (the
// 4th card), or follows the packs straight away if there are fewer than three.
const CUSTOM_SLOT = 3;

type SetSession = (f: (s: BuilderSession) => BuilderSession) => void;

function PackCard({
  pack,
  recommended,
  cardRef,
  onAdd,
}: {
  pack: AgentPack;
  onAdd: () => Promise<void>;
  recommended: string | null; // the builder's reason, when it recommends this pack
  cardRef: (el: HTMLElement | null) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const add = async () => {
    setAdding(true);
    setError(null);
    try {
      await onAdd();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setAdding(false);
    }
  };
  return (
    <article className={`pack${recommended !== null ? ' recommended' : ''}`} ref={cardRef}>
      <div className="pack-body">
        {recommended !== null && (
          <div className="pack-rec">
            <span className="pack-rec-tag">Recommended</span>
            {recommended && <p>{recommended}</p>}
          </div>
        )}
        <h2 className="pack-name">{pack.name}</h2>
        <p className="pack-tagline">{pack.tagline}</p>
        <div className="pack-count">
          {pack.agents.length} agent{pack.agents.length === 1 ? '' : 's'}
        </div>
        <div className="pack-divider" />
        <ul className="pack-agents">
          {pack.agents.map(a => {
            const Icon = DEPARTMENT_ICON[a.department];
            return (
              <li key={a.name}>
                <Icon size={16} strokeWidth={1.75} className="pack-agent-icon" />
                <div>
                  <div className="pack-agent-name">{a.name}</div>
                  <div className="pack-agent-does">{a.does}</div>
                </div>
              </li>
            );
          })}
        </ul>
        <button className="pack-add" disabled={adding} onClick={add}>
          <Plus size={15} strokeWidth={2} />
          Add {pack.name.toLowerCase()} pack
        </button>
        {error && <div className="custom-error">{error}</div>}
      </div>
    </article>
  );
}

// The custom card is the builder's input: you write straight into it.
function CustomCard({
  session,
  onSubmit,
  onReopen,
  cardRef,
}: {
  session: BuilderSession;
  onSubmit: (text: string) => void;
  onReopen: () => void;
  cardRef: React.Ref<HTMLElement>;
}) {
  const [text, setText] = useState('');
  const { phase } = session;
  const started = phase === 'chat' || phase === 'building';
  // Cleared once the builder has taken it, so a failed send keeps your words.
  useEffect(() => {
    if (phase === 'recommended' || phase === 'chat') setText('');
  }, [phase]);
  const send = () => {
    const t = text.trim();
    if (!t || phase === 'matching') return;
    onSubmit(t);
  };
  return (
    <article className={`pack custom${phase === 'matching' ? ' busy' : ''}`} ref={cardRef}>
      <div className="pack-body">
        <div className="custom-mark">
          <Sparkles size={22} strokeWidth={1.6} />
        </div>
        <h2 className="pack-name">Customize your own agent</h2>
        {phase === 'recommended' ? (
          <p className="pack-tagline">Not quite it? Say what's different and we'll build your own.</p>
        ) : (
          <p className="pack-tagline">
            Describe the job in your own words and build an agent for exactly that - its tools, its schedule, how hard
            it works.
          </p>
        )}
        {started ? (
          <button className="pack-add custom-add" onClick={onReopen}>
            Continue building
          </button>
        ) : (
          <div className="custom-input">
            <textarea
              value={text}
              rows={4}
              disabled={phase === 'matching'}
              placeholder={phase === 'recommended' ? "How it's different..." : 'What should it do?'}
              onChange={e => setText(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
            />
            <button className="custom-send" onClick={send} disabled={!text.trim() || phase === 'matching'} aria-label="Send">
              <ArrowUp size={16} strokeWidth={2.25} />
            </button>
          </div>
        )}
        {phase === 'matching' && <div className="custom-status">Checking the packs first...</div>}
        {session.error && !session.open && <div className="custom-error">{session.error}</div>}
      </div>
    </article>
  );
}

export function NewAgent({
  session,
  setSession,
  onBuilt,
}: {
  session: BuilderSession;
  setSession: SetSession;
  onBuilt: (b: Built[]) => void;
}) {
  const packEls = useRef(new Map<string, HTMLElement>());
  const customEl = useRef<HTMLElement>(null);
  const [origin, setOrigin] = useState<DOMRect | null>(null);

  // The organisation profile comes first: every agent is written for it. The
  // first add (a description or a pack) opens a short chat to fill it in, then
  // carries on with what you were doing.
  const [hasProfile, setHasProfile] = useState<boolean | null>(null);
  useEffect(() => {
    getProfile()
      .then(p => setHasProfile(!!p))
      .catch(() => setHasProfile(null)); // server down: ask again on the first add
  }, []);
  const [prof, setProf] = useState<BuilderSession>(NEW_SESSION);
  const [profOrigin, setProfOrigin] = useState<DOMRect | null>(null);
  const draft = useRef<Profile | null>(null);
  const pending = useRef<(() => void) | null>(null);
  const withProfile = async (from: HTMLElement | null | undefined, action: () => void) => {
    let known = hasProfile;
    if (known === null) known = await getProfile().then(p => !!p, () => false);
    if (known) return action();
    pending.current = action;
    setProfOrigin(from?.getBoundingClientRect() ?? null);
    setProf({ ...NEW_SESSION, phase: 'chat', open: true, turns: [{ role: 'builder', text: PROFILE_OPENER }] });
  };
  const profReply = (text: string) => {
    const turns: Turn[] = [...prof.turns, { role: 'person', text }];
    setProf(s => ({ ...s, turns, ready: false }));
    profAsk(turns);
  };
  const profAsk = async (turns: Turn[]) => {
    setProf(s => ({ ...s, thinking: true, error: null }));
    try {
      const r = await profileTurn(turns);
      draft.current = r.profile;
      setProf(s => ({ ...s, thinking: false, turns: [...s.turns, { role: 'builder', text: r.reply }], confidence: r.confidence, ready: r.ready }));
    } catch (e) {
      setProf(s => ({ ...s, thinking: false, error: (e as Error).message }));
    }
  };
  const profSave = async () => {
    if (!draft.current) return;
    setProf(s => ({ ...s, phase: 'building', error: null }));
    try {
      await saveProfile(draft.current);
      setHasProfile(true);
      setProf(NEW_SESSION);
      const next = pending.current;
      pending.current = null;
      next?.();
    } catch (e) {
      setProf(s => ({ ...s, phase: 'chat', error: (e as Error).message }));
    }
  };

  // Bring a recommended pack into view.
  const recId = session.phase === 'recommended' ? session.recommended?.packId : undefined;
  useEffect(() => {
    if (recId) packEls.current.get(recId)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [recId]);

  // The pop-up grows out of the custom card.
  useLayoutEffect(() => {
    if (session.open) setOrigin(customEl.current?.getBoundingClientRect() ?? null);
  }, [session.open]);

  const ask = async (turns: Turn[], declinedPack: string | null) => {
    setSession(s => ({ ...s, thinking: true, error: null }));
    try {
      const r = await nextTurn(turns, declinedPack);
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

  const openChat = (turns: Turn[], declinedPack: string | null) => {
    setSession(s => ({ ...s, phase: 'chat', open: true, turns, declinedPack }));
    ask(turns, declinedPack);
  };

  const submitBox = (text: string) => withProfile(customEl.current, () => describe(text));
  const describe = async (text: string) => {
    if (session.phase === 'recommended') {
      // Carried on past the recommendation: it's different. Never recommend again.
      const pack = AGENT_PACKS.find(p => p.id === session.recommended?.packId);
      customEl.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      openChat([...session.turns, { role: 'person', text }], pack?.name ?? null);
      return;
    }
    const turns: Turn[] = [{ role: 'person', text }];
    setSession(s => ({ ...s, phase: 'matching', turns, error: null }));
    try {
      const m = await matchPack(text);
      if (m.pack_id) setSession(s => ({ ...s, phase: 'recommended', recommended: { packId: m.pack_id!, reason: m.reason } }));
      else openChat(turns, null);
    } catch (e) {
      setSession(s => ({ ...s, phase: 'idle', turns: [], error: (e as Error).message }));
    }
  };

  const reply = (text: string) => {
    const turns: Turn[] = [...session.turns, { role: 'person', text }];
    setSession(s => ({ ...s, turns, ready: false }));
    ask(turns, session.declinedPack);
  };

  const build = async () => {
    setSession(s => ({ ...s, phase: 'building', error: null }));
    try {
      onBuilt([await buildAgent(session.turns)]);
    } catch (e) {
      setSession(s => ({ ...s, error: (e as Error).message }));
    } finally {
      setSession(s => ({ ...s, phase: 'chat' }));
    }
  };

  const at = Math.min(CUSTOM_SLOT, AGENT_PACKS.length);
  const pack = (p: AgentPack) => (
    <PackCard
      key={p.id}
      pack={p}
      recommended={recId === p.id ? (session.recommended?.reason ?? '') : null}
      cardRef={el => (el ? packEls.current.set(p.id, el) : packEls.current.delete(p.id))}
      onAdd={() =>
        withProfile(packEls.current.get(p.id), async () => {
          try {
            onBuilt(await addPack(p.id));
          } catch (e) {
            window.alert((e as Error).message);
          }
        })
      }
    />
  );
  const cards = [
    ...AGENT_PACKS.slice(0, at).map(pack),
    <CustomCard
      key="custom"
      session={session}
      onSubmit={submitBox}
      onReopen={() => setSession(s => ({ ...s, open: true }))}
      cardRef={customEl}
    />,
    ...AGENT_PACKS.slice(at).map(pack),
  ];
  return (
    <div className="packs-wrap">
      <div className="packs">{cards}</div>
      {session.open && origin && (
        <BuilderChat
          origin={origin}
          session={session}
          onReply={reply}
          onRetry={() => ask(session.turns, session.declinedPack)}
          onBuild={build}
          onClose={() => setSession(s => ({ ...s, open: false }))}
        />
      )}
      {prof.open && profOrigin && (
        <BuilderChat
          origin={profOrigin}
          session={prof}
          title="Your organisation"
          buildLabel="Save and continue"
          buildingText="Saving your organisation"
          busyLabel="Saving"
          onReply={profReply}
          onRetry={() => profAsk(prof.turns)}
          onBuild={profSave}
          onClose={() => {
            pending.current = null;
            setProf(NEW_SESSION);
          }}
        />
      )}
    </div>
  );
}
