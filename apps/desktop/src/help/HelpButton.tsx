import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { HELP_TOPICS, HELP_TOPIC_IDS, type HelpCaption, type HelpTopicId } from './topics';
import { DIAGRAMS } from './diagrams';
import type { View } from '../Sidebar';
import { markHelpRead, useHelpUnread } from './readState';
import './help.css';

const GROW_MS = 420; // matches the CSS transition

// The "?" at the top right of a page. While its topic is unread it glows with
// a yellow sonar pulse. It opens the help window on its own page's tab - or,
// until Getting started has been read, glows on every page and opens on that.
// `onNavigate` follows a caption's link to a page (see withLinks).
export function HelpButton({ topic: pageTopic, onNavigate }: { topic: HelpTopicId; onNavigate?: (view: View) => void }) {
  const newHere = useHelpUnread('start');
  const topic = newHere ? 'start' : pageTopic;
  const unread = useHelpUnread(pageTopic) || newHere;
  const button = useRef<HTMLButtonElement>(null);
  const [origin, setOrigin] = useState<DOMRect | null>(null);
  const [caught, setCaught] = useState(false); // the window just shrank back into it

  return (
    <>
      <button
        ref={button}
        className={`help-btn${unread ? ' unread' : ''}${origin ? ' open' : ''}${caught ? ' caught' : ''}`}
        onAnimationEnd={() => setCaught(false)}
        onClick={() => setOrigin(button.current!.getBoundingClientRect())}
        aria-label={unread ? `${HELP_TOPICS[topic].title} help - new` : `${HELP_TOPICS[topic].title} help`}
        title={unread ? 'New here? Start with this' : 'Help'}
      >
        ?
      </button>
      {origin && (
        <HelpWindow
          origin={origin}
          initial={topic}
          onClosed={() => {
            setOrigin(null);
            setCaught(true);
          }}
          onNavigate={onNavigate}
        />
      )}
    </>
  );
}

// A caption's [words](tab) become a link to that tab's help, and
// [words](page:view) a link to that page of the app (closing the window).
type Follow = (target: HelpTopicId | `page:${View}`) => void;
function withLinks(text: string, go: Follow): ReactNode[] {
  return text.split(/(\[[^\]]+\]\([\w:-]+\))/).map((part, i) => {
    const m = /^\[([^\]]+)\]\(([\w:-]+)\)$/.exec(part);
    if (!m || !(m[2] in HELP_TOPICS || m[2].startsWith('page:'))) return part;
    const target = m[2] as Parameters<Follow>[0];
    return (
      <button key={i} className="help-link" onClick={() => go(target)}>
        {m[1]}
      </button>
    );
  });
}

// A caption: one paragraph, or lines and bullet lists.
function Caption({ caption, go }: { caption: HelpCaption; go: Follow }) {
  if (typeof caption === 'string') return <p>{withLinks(caption, go)}</p>;
  return (
    <div className="help-caption">
      {caption.map((block, i) =>
        typeof block === 'string' ? (
          <p key={i}>{withLinks(block, go)}</p>
        ) : (
          <ul key={i}>
            {block.map(item => (
              <li key={item}>{withLinks(item, go)}</li>
            ))}
          </ul>
        ),
      )}
    </div>
  );
}

// Grows out of the "?" into the middle of the screen (like the agent builder
// grows out of its card), and shrinks back into it on close. Tabs down the
// side switch between every page's help; viewing a tab marks it read.
function HelpWindow({
  origin,
  initial,
  onClosed,
  onNavigate,
}: {
  origin: DOMRect;
  initial: HelpTopicId;
  onClosed: () => void;
  onNavigate?: (view: View) => void;
}) {
  const [grown, setGrown] = useState(false);
  const [closing, setClosing] = useState(false);
  const [tab, setTabState] = useState<HelpTopicId>(initial);
  // Where you were in each tab, so following a link and coming back puts you
  // back where you left off (for as long as the window is open).
  const scrolled = useRef<Partial<Record<HelpTopicId, number>>>({});
  const setTab = (id: HelpTopicId) => {
    scrolled.current[tab] = body.current?.scrollTop ?? 0;
    setTabState(id);
  };
  const body = useRef<HTMLDivElement>(null);
  const topic = HELP_TOPICS[tab];

  useLayoutEffect(() => {
    const id = requestAnimationFrame(() => requestAnimationFrame(() => setGrown(true)));
    return () => cancelAnimationFrame(id);
  }, []);
  useEffect(() => {
    markHelpRead(tab);
    body.current?.scrollTo({ top: scrolled.current[tab] ?? 0 });
  }, [tab]);

  const close = (then?: () => void) => {
    if (closing) return;
    setClosing(true);
    setGrown(false);
    setTimeout(() => {
      onClosed();
      then?.();
    }, GROW_MS);
  };
  const follow: Follow = target => {
    if (!target.startsWith('page:')) return setTab(target as HelpTopicId);
    close(() => onNavigate?.(target.slice(5) as View));
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const start = { top: origin.top, left: origin.left, width: origin.width, height: origin.height };
  return (
    <div className={`help-scrim${grown ? ' in' : ''}`} onMouseDown={e => e.target === e.currentTarget && close()}>
      <div className={`help-window${grown ? ' grown' : ''}${closing ? ' closing' : ''}`} style={grown ? undefined : start} role="dialog" aria-label="Help">
        <nav className="help-nav">
          <div className="help-nav-title">Help</div>
          {HELP_TOPIC_IDS.map(id => (
            <HelpTab key={id} id={id} on={id === tab} onSelect={() => setTab(id)} />
          ))}
        </nav>
        <div className="help-body" ref={body}>
          <header className="help-head">
            <h2>{topic.title}</h2>
            <button className="help-close" onClick={() => close()} aria-label="Close help">
              <X size={18} />
            </button>
          </header>
          {topic.sections.map(s => {
            const Diagram = s.diagram && DIAGRAMS[s.diagram];
            return (
              <section key={s.heading} className="help-section">
                <h3>{s.heading}</h3>
                {Diagram && <Diagram />}
                {s.caption && <Caption caption={s.caption} go={follow} />}
              </section>
            );
          })}
          <footer className="help-foot">
            <button className="help-done" onClick={() => close()}>
              Got it
            </button>
          </footer>
        </div>
      </div>
    </div>
  );
}

function HelpTab({ id, on, onSelect }: { id: HelpTopicId; on: boolean; onSelect: () => void }) {
  const unread = useHelpUnread(id);
  return (
    <button className={`help-tab${on ? ' on' : ''}`} onClick={onSelect} aria-current={on}>
      {HELP_TOPICS[id].title}
      {unread && <span className="help-tab-new" aria-label="not read yet" />}
    </button>
  );
}
