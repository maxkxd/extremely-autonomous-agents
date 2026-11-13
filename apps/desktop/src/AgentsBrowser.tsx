import { useCallback, useEffect, useRef, useState } from 'react';
import { Globe, Hand, MousePointerClick, Plus, Undo2, User } from 'lucide-react';
import { liveBrowser, liveControl, liveFrame, liveInput, liveOpen, openAgentBrowser, type LiveFrame, type LiveNeed, type LiveTab, type PersonInput } from './builder';
import { notifyError } from './Notices';
import { BusyLabel, Working } from './Busy';
import { untilLooking } from './poll';

// The agents' browser, live (server: runner/live-view.ts). On the left, what waits on
// you (CAPTCHAs, sign-ins, codes an agent asked for) and every page the agents have
// open, small and about once a second; on the right the one you pick, as it changes.
// Take control and your mouse, keys, pasted text and scrolling go to that page only,
// and its agent waits on it until you hand it back. In the cloud each profile's whole
// browser is here too, as its screen - every window in it, yours to use any time, as
// the browser itself is on your own screen.

const ago = (at: number) => {
  const m = Math.max(0, Math.round((Date.now() - at) / 60_000));
  return m < 1 ? 'just now' : m < 60 ? `${m} min` : `${Math.round(m / 60)} h`;
};
const siteOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url || 'a new page';
  }
};
const firstToShow = (tabs: LiveTab[]) =>
  tabs.find(t => t.kind === 'agent' && t.held) ?? tabs.find(t => t.kind === 'agent' && t.request != null) ?? tabs.find(t => t.held) ?? tabs[0];
const mods = (e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) => (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
const BUTTON = ['left', 'middle', 'right'] as const;
// Keys whose character goes in as text (not Enter: it's a key with "\r").
const textOf = (e: React.KeyboardEvent) => (e.ctrlKey || e.metaKey ? undefined : e.key === 'Enter' ? '\r' : e.key.length === 1 ? e.key : undefined);

export function AgentsBrowser({ openTab, onOpened }: { openTab: string | null; onOpened: () => void }) {
  const [tabs, setTabs] = useState<LiveTab[] | null>(null);
  const [needs, setNeeds] = useState<LiveNeed[]>([]);
  const [profiles, setProfiles] = useState<number[]>([1]);
  const [profile, setProfile] = useState<number | 'all'>('all');
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [signInUrl, setSignInUrl] = useState('');
  const [opening, setOpening] = useState(false);

  // The list, with its thumbnails, about once a second.
  const refresh = useCallback(async () => {
    try {
      const s = await liveBrowser(true);
      setTabs(s.tabs);
      setNeeds(s.needs);
      setProfiles(s.profiles.length ? s.profiles : [1]);
      setError(null);
      return s;
    } catch (e) {
      setError((e as Error).message);
      return null;
    }
  }, []);
  // Only while someone is looking (poll.ts): the desktop window keeps running in the tray
  // after it's closed, and this was a request a second, with thumbnails, through the relay.
  useEffect(() => {
    const stop = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      await untilLooking(stop.signal);
      if (stop.signal.aborted) return;
      await refresh();
      if (!stop.signal.aborted) timer = setTimeout(tick, 1000);
    };
    void tick();
    return () => (stop.abort(), clearTimeout(timer));
  }, [refresh]);

  // A page opened for you elsewhere (a request's button, Connectors): shown here.
  useEffect(() => {
    if (!openTab) return;
    setSelected(openTab);
    onOpened();
  }, [openTab, onOpened]);
  useEffect(() => {
    const on = (e: Event) => setSelected((e as CustomEvent<{ tab: string }>).detail.tab);
    window.addEventListener('eaa:agents-browser', on);
    return () => window.removeEventListener('eaa:agents-browser', on);
  }, []);

  const shown = (tabs ?? []).filter(t => profile === 'all' || t.profile === profile);
  const current = (tabs ?? []).find(t => t.id === selected) ?? null;
  // Nothing picked (or it closed): a page you've taken, then one kept waiting for you,
  // then the rest. (In the cloud the profile's screen is always "yours", and it was
  // picked first - showing whichever agent's window was on top, not the waiting page.)
  useEffect(() => {
    if (!tabs || (selected && tabs.some(t => t.id === selected))) return;
    if (selected && openTab === selected) return; // just opened: in the next list
    setSelected(firstToShow(tabs)?.id ?? null);
  }, [tabs, selected, openTab]);

  const openNeed = async (n: LiveNeed) => {
    if (opening) return;
    setOpening(true);
    try {
      const r = await openAgentBrowser(n.profile, n.url, n.request);
      if (r.live) setSelected(r.live);
      else await refresh();
    } catch (e) {
      notifyError(e);
    } finally {
      setOpening(false);
    }
  };

  // Done: the next thing waiting - a page you have, else the next request.
  const next = async (from: string) => {
    const s = await refresh();
    const rest = (s?.tabs ?? []).filter(t => t.id !== from);
    const yours = rest.find(t => t.kind === 'agent' && (t.held || t.request != null));
    if (yours) return setSelected(yours.id);
    const need = (s?.needs ?? []).find(n => !rest.some(t => t.request === n.request));
    if (need) return openNeed(need);
    setSelected(rest[0]?.id ?? null);
  };
  const act = async (action: 'take' | 'done' | 'handback') => {
    if (!current) return;
    try {
      await liveControl(current.id, action);
      if (action === 'done') await next(current.id);
      else await refresh();
    } catch (e) {
      notifyError(e);
    }
  };

  const openProfile = async () => {
    if (opening) return;
    const n = profile === 'all' ? profiles[0] : profile;
    const url = signInUrl.trim() ? (/^https?:\/\//.test(signInUrl.trim()) ? signInUrl.trim() : `https://${signInUrl.trim()}`) : 'https://www.google.com';
    setOpening(true);
    try {
      const { tab } = await liveOpen(n, url);
      setSignInUrl('');
      // Here the window opens on this screen; in the cloud, on the page.
      if (tab) setSelected(tab);
      await refresh();
    } catch (e) {
      notifyError(e);
    } finally {
      setOpening(false);
    }
  };

  if (tabs === null && !error) return <div className="main-empty"><Working text="Looking at the agents’ browser" /></div>;
  return (
    <div className="abrowser">
      <aside className="abrowser-side">
        {needs.length > 0 && (
          <section>
            <h2 className="abrowser-h">Needs you</h2>
            {needs.map(n => {
              const open = tabs?.find(t => t.request === n.request);
              return (
                <button key={n.request} className={`abrowser-need${open && open.id === selected ? ' on' : ''}`} disabled={opening && !open} onClick={() => (open ? setSelected(open.id) : openNeed(n))}>
                  <Hand size={14} />
                  <span className="abrowser-need-text">
                    <strong>{n.agent.name}</strong> · {n.site}
                    <span className="abrowser-muted">waiting {ago(n.since)}</span>
                  </span>
                </button>
              );
            })}
          </section>
        )}
        <section>
          <h2 className="abrowser-h">Pages</h2>
          {profiles.length > 1 && (
            <div className="abrowser-chips">
              {(['all', ...profiles] as const).map(p => (
                <button key={p} className={`abrowser-chip${profile === p ? ' on' : ''}`} onClick={() => setProfile(p)}>
                  {p === 'all' ? 'All profiles' : `Profile ${p}`}
                </button>
              ))}
            </div>
          )}
          {shown.length === 0 && <p className="abrowser-empty">No agent has a page open right now.</p>}
          <div className="abrowser-thumbs">
            {shown.map(t => (
              <button key={t.id} className={`abrowser-thumb${t.id === selected ? ' on' : ''}${t.held ? ' held' : ''}`} onClick={() => setSelected(t.id)}>
                {t.thumb ? <img src={`data:image/jpeg;base64,${t.thumb}`} alt="" /> : <span className="abrowser-thumb-blank" />}
                <span className="abrowser-thumb-label">
                  {t.kind === 'person' ? <User size={12} /> : null}
                  <strong>{t.kind === 'person' ? `Profile ${t.profile}` : (t.agent?.name ?? 'An agent')}</strong>
                  <span className="abrowser-muted">{siteOf(t.url)}</span>
                </span>
              </button>
            ))}
          </div>
        </section>
        <section className="abrowser-signin">
          <h2 className="abrowser-h">Open a profile to sign in</h2>
          <form onSubmit={e => (e.preventDefault(), void openProfile())}>
            <input value={signInUrl} onChange={e => setSignInUrl(e.target.value)} placeholder="linkedin.com" aria-label="The page to open" />
            <button className="sbtn" type="submit" disabled={opening}>
              <BusyLabel busy={opening} busyText="Opening">
                <Plus size={14} /> {`Open${profile !== 'all' && profiles.length > 1 ? ` in profile ${profile}` : ''}`}
              </BusyLabel>
            </button>
          </form>
        </section>
        {error && <p className="abrowser-error">{error}</p>}
      </aside>
      <section className="abrowser-main">{current ? <LivePage key={current.id} tab={current} onAct={act} /> : <div className="main-empty">Pick a page on the left to watch it.</div>}</section>
    </div>
  );
}

// One page, as it changes, and - once it's yours - your input on it.
function LivePage({ tab, onAct }: { tab: LiveTab; onAct: (a: 'take' | 'done' | 'handback') => void }) {
  const [frame, setFrame] = useState<LiveFrame | null>(null);
  const [streamError, setStreamError] = useState<string | null>(null);
  const img = useRef<HTMLImageElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const mine = tab.held != null;
  const mineRef = useRef(mine);
  mineRef.current = mine;
  const size = useRef({ width: 1280, height: 900 });

  // The next frame after the one shown, for as long as it's on screen - and only while
  // someone is looking (poll.ts). Away, it stops asking, and the host stops streaming a
  // few seconds later; back, it starts again from the first frame (the stream's count
  // starts over when it does).
  useEffect(() => {
    const stop = new AbortController();
    const alive = () => !stop.signal.aborted;
    let seq = 0;
    void (async () => {
      while (alive()) {
        try {
          if (await untilLooking(stop.signal)) seq = 0;
          if (!alive()) return;
          const f = await liveFrame(tab.id, seq);
          if (!alive()) return;
          if (f.data) {
            seq = f.seq;
            size.current = { width: f.width, height: f.height };
            setFrame(f);
            setStreamError(null);
          }
        } catch (e) {
          if (!alive()) return;
          const message = (e as Error).message;
          console.error(`[browser] frame ${tab.id}:`, message);
          setStreamError(message);
          await new Promise(r => setTimeout(r, 1000));
        }
      }
    })();
    return () => stop.abort();
  }, [tab.id]);

  // Input goes out every 40 ms, mouse moves only the latest.
  const queue = useRef<PersonInput[]>([]);
  useEffect(() => {
    const t = setInterval(() => {
      if (!queue.current.length) return;
      const events = queue.current.filter((e, i, all) => !(e.type === 'mouse' && e.action === 'mouseMoved' && all.slice(i + 1).some(x => x.type === 'mouse' && x.action === 'mouseMoved')));
      queue.current = [];
      void liveInput(tab.id, events).catch(e => {
        const message = (e as Error).message;
        console.error(`[browser] input ${tab.id}:`, message);
        setStreamError(message);
      });
    }, 40);
    return () => clearInterval(t);
  }, [tab.id]);
  const send = (e: PersonInput) => mineRef.current && queue.current.push(e);
  const at = (e: { clientX: number; clientY: number }) => {
    const r = img.current!.getBoundingClientRect();
    return { x: Math.round(((e.clientX - r.left) * size.current.width) / r.width), y: Math.round(((e.clientY - r.top) * size.current.height) / r.height) };
  };
  const mouse = (action: 'mousePressed' | 'mouseReleased' | 'mouseMoved') => (e: React.MouseEvent) => {
    if (!mineRef.current) return;
    e.preventDefault();
    if (action === 'mousePressed') box.current?.focus();
    send({ type: 'mouse', action, ...at(e), button: action === 'mouseMoved' ? (e.buttons & 1 ? 'left' : 'none') : BUTTON[e.button] ?? 'left', buttons: e.buttons, clickCount: action === 'mouseMoved' ? 0 : e.detail || 1, modifiers: mods(e) });
  };
  // A wheel that scrolls the page there, not this one.
  useEffect(() => {
    const el = img.current;
    if (!el) return;
    const on = (e: WheelEvent) => {
      if (!mineRef.current) return;
      e.preventDefault();
      send({ type: 'wheel', ...at(e), deltaX: e.deltaX, deltaY: e.deltaY, modifiers: mods(e) });
    };
    el.addEventListener('wheel', on, { passive: false });
    return () => el.removeEventListener('wheel', on);
  });
  const key = (action: 'down' | 'up') => (e: React.KeyboardEvent) => {
    if (!mineRef.current) return;
    // Pasting is the paste below (the page there can't read this computer's clipboard).
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') return;
    e.preventDefault();
    send({ type: 'key', action, key: e.key, code: e.code, keyCode: e.keyCode, text: action === 'down' ? textOf(e) : undefined, modifiers: mods(e) });
  };

  const site = siteOf(tab.url);
  return (
    <div className="abrowser-live">
      <header className="abrowser-bar">
        <span className="abrowser-bar-who">
          {tab.kind === 'person' ? <User size={14} /> : <Globe size={14} />}
          <strong>{tab.kind === 'person' ? `Profile ${tab.profile}'s browser` : (tab.agent?.name ?? 'An agent')}</strong>
          <span className="abrowser-muted" title={tab.url}>
            {site}
            {tab.title ? ` · ${tab.title}` : ''}
          </span>
        </span>
        <span className="abrowser-bar-actions">
          {mine ? (
            <>
              <span className="abrowser-control">You have control</span>
              <button className="sbtn primary" onClick={() => onAct('done')}>
                Done, next
              </button>
              <button className="sbtn" onClick={() => onAct('handback')}>
                <Undo2 size={14} /> Hand back
              </button>
            </>
          ) : (
            <button className="sbtn" onClick={() => onAct('take')}>
              <MousePointerClick size={14} /> Take control
            </button>
          )}
        </span>
      </header>
      <div
        ref={box}
        className={`abrowser-screen${mine ? ' mine' : ''}`}
        tabIndex={0}
        onKeyDown={key('down')}
        onKeyUp={key('up')}
        onPaste={e => {
          if (!mineRef.current) return;
          e.preventDefault();
          const text = e.clipboardData.getData('text');
          if (text) send({ type: 'text', text });
        }}
        onContextMenu={e => mine && e.preventDefault()}
      >
        {frame?.data ? (
          <img
            ref={img}
            src={`data:image/jpeg;base64,${frame.data}`}
            alt={`${tab.agent?.name ?? 'Your'} page at ${site}`}
            draggable={false}
            onMouseDown={mouse('mousePressed')}
            onMouseUp={mouse('mouseReleased')}
            onMouseMove={mouse('mouseMoved')}
          />
        ) : (
          <div className="main-empty">{streamError ?? <Working text="Connecting to the page" />}</div>
        )}
      </div>
    </div>
  );
}
