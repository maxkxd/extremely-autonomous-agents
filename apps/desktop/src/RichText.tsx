import { Fragment, useState } from 'react';
import { doneInBrowser, showInBrowser } from './builder';
import { notifyError } from './Notices';

// Agents' and the Agency Engineer's text, made easy to follow: numbered steps as a
// numbered list (also when they're written inline, "1. Do this. 2. Then that."),
// "- " lines as bullets, `code` set apart, web addresses as links, and other
// requests ("request #41", "#41") as links that take you to them.

// request: the one this text is on (its server id), if any.
type Ref = { onRequest?: (id: number) => void; canOpen?: (id: number) => boolean; onSettings?: (integration: string | null) => void; request?: number };

// "Settings > Connectors > Integrations > Sentry Errors": where to connect
// something. A link to it in Settings (the integration glowing), when the app
// can open Settings from here.
// ("Settings > Connectors" is how the app writes it; "->" and "→" are older messages.)
// (The name stops at a bracket: "Gmail (never into the chat)" linked the aside too.)
const SETTINGS_RE = /Settings\s*(?:->|→|>)\s*Connectors(?:\s*(?:->|→|>)\s*Integrations)?(?:\s*(?:->|→|>)\s*([^.,;:(\n]+))?/g;
const SETTINGS_LINE = /^\s*(?:Where:\s*)?Settings\s*(?:->|→|>)\s*Connectors(?:\s*(?:->|→|>)\s*Integrations)?\s*(?:->|→|>)\s*([^.,;:\n]+?)\.?(?:\s*Keys go there, never in this chat\.)?\s*$/;

function Inline({ text, refs }: { text: string; refs: Ref }) {
  if (!refs.onSettings) return <InlineCore text={text} refs={refs} />;
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(SETTINGS_RE)) {
    const at = m.index ?? 0;
    const name = m[1]?.trim() || null;
    parts.push(<InlineCore key={`t${at}`} text={text.slice(last, at)} refs={refs} />);
    parts.push(
      <a key={`s${at}`} className="text-link" href="#" onClick={e => (e.preventDefault(), refs.onSettings!(name))}>
        {/* Shown as the app writes it, whichever arrows the message used. */}
        {m[0].trim().replace(/\s*(?:->|→|>)\s*/g, ' > ')}
      </a>,
    );
    last = at + m[0].trimEnd().length;
  }
  parts.push(<InlineCore key="end" text={text.slice(last)} refs={refs} />);
  return <>{parts}</>;
}

// "Open in signed-in browser: https://www.linkedin.com/login (profile 2)": on a request,
// a button that brings the tab the agent kept for it to the front of the person's own
// browser (docs/browser-extension.md). Closing that tab answers the request, and the
// agent hears. Anywhere else the line stays text, its address a plain link.
// A short label before it still counts: a request's card puts its evidence under
// "Details: " (App.tsx), which left every such line a plain link - #208 said "press the
// button" with no button there.
const BROWSER_LINE = /^\s*(?:[A-Za-z][\w ]{0,20}:\s*)?Open in signed-in browser:\s*(https?:\/\/[^\s<>"']+?)[.,]?(?:\s*\((?:profile|browser)\s*(\d+)\))?\.?\s*$/i;
const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
};

function BrowserButton({ url, request, browser }: { url: string; request: number; browser?: number }) {
  const [opened, setOpened] = useState(false);
  const google = /^accounts\.(google|youtube)\.com$/.test(hostOf(url));
  // kept: it was the request's own page, so Done answers it and gives the tab back.
  const [kept, setKept] = useState(false);
  const open = () => showInBrowser(request, url, browser).then(r => (setOpened(true), setKept(!!r.kept)), notifyError);
  // Pressed once only: after it works the page is the agent's again, so Done goes.
  const [finishing, setFinishing] = useState(false);
  const done = () => {
    setFinishing(true);
    doneInBrowser(request)
      .then(() => setKept(false), notifyError)
      .finally(() => setFinishing(false));
  };
  if (opened && kept)
    return (
      <span className="rt-browser">
        <button className="rt-settings" disabled={finishing} onClick={done}>
          Done
        </button>{' '}
        <button className="rt-settings" onClick={open}>
          Open it again
        </button>
      </span>
    );
  return (
    <button className="rt-settings" onClick={open}>
      {opened ? 'Open it again' : google ? 'Sign in to Google in your browser' : 'Open it in your browser'}
    </button>
  );
}

const URL_RE = /https?:\/\/[^\s<>"']+/g;
const TRAILING = /[.,;:!?)\]]+$/;
const BULLET = /^\s*(?:[-*•])\s+(.*)$/;
const NUMBERED = /^\s*(\d+)[.)]\s+(.*)$/;

// "... 1. Reply on #41. 2. Once confirmed ..." -> each step on its own line,
// when the numbers run 1, 2, 3... (so "version 2. Then" isn't split).
function unfoldSteps(text: string): string {
  return text
    .split('\n')
    .map(line => {
      const cuts: number[] = [];
      let from = 0;
      for (let n = 1; ; n++) {
        const m = new RegExp(`(^|\\s)${n}[.)]\\s`).exec(line.slice(from));
        if (!m) break;
        const at = from + m.index + m[1].length;
        cuts.push(at);
        from = at + 2;
      }
      if (cuts.length < 2) return line;
      return [line.slice(0, cuts[0]).trimEnd(), ...cuts.map((c, i) => line.slice(c, cuts[i + 1]).trimEnd())].filter(Boolean).join('\n');
    })
    .join('\n');
}

// Inline: `code`, links, request references.
function InlineCore({ text, refs }: { text: string; refs: Ref }) {
  const parts: React.ReactNode[] = [];
  const re = new RegExp(`\`([^\`]+)\`|${URL_RE.source}|(?:\\b[Rr]equest\\s+)?#(\\d+)\\b|\\*\\*([^*]+)\\*\\*`, 'g');
  let last = 0;
  for (const m of text.matchAll(re)) {
    const at = m.index ?? 0;
    parts.push(text.slice(last, at));
    if (m[1] !== undefined) parts.push(<code key={at} className="rt-code">{m[1]}</code>);
    else if (m[3] !== undefined) parts.push(<strong key={at}>{m[3]}</strong>);
    else if (m[2] !== undefined) {
      // "request #41" is a request; a bare "#41" only when it's one on the page
      // (it could be a GitHub issue). Where there are no requests, plain text.
      const id = Number(m[2]);
      const named = /^request/i.test(m[0]);
      parts.push(
        refs.onRequest && refs.canOpen?.(id) ? (
          <a key={at} className="text-link" href="#" onClick={e => (e.preventDefault(), refs.onRequest!(id))}>
            {m[0]}
          </a>
        ) : refs.onRequest && named ? (
          <span key={at} className="rt-ref" title="That request isn't on your Requests page: it's closed, someone else's, or the Agency Engineer is still working on it">
            {m[0]}
          </span>
        ) : (
          m[0]
        ),
      );
    } else {
      const url = m[0].replace(TRAILING, '');
      parts.push(
        <a key={at} className="text-link" href={url} target="_blank" rel="noreferrer noopener">
          {url}
        </a>,
      );
      last = at + url.length;
      continue;
    }
    last = at + m[0].length;
  }
  parts.push(text.slice(last));
  return <>{parts}</>;
}

export function RichText({ text, onRequest, canOpen, onSettings, request }: { text: string } & Ref) {
  const refs = { onRequest, canOpen, onSettings };
  const lines = unfoldSteps(text).split('\n');
  const blocks: React.ReactNode[] = [];
  // Kept pages to bring up in the person's browser: buttons after the text, not splitting its steps.
  const pages: React.ReactNode[] = [];
  let para: string[] = [];
  // (Typed by assertion: it's changed inside the closures below too.)
  let list = null as { kind: 'ol' | 'ul'; start: number; items: string[] } | null;
  const flushPara = () => {
    if (para.length)
      blocks.push(
        <p key={blocks.length} className="rt-p">
          {para.map((l, i) => (
            <Fragment key={i}>
              {i > 0 && <br />}
              <Inline text={l} refs={refs} />
            </Fragment>
          ))}
        </p>,
      );
    para = [];
  };
  const flushList = () => {
    if (!list) return;
    const items = list.items.map((t, i) => (
      <li key={i}>
        <Inline text={t} refs={refs} />
      </li>
    ));
    blocks.push(
      list.kind === 'ol' ? (
        <ol key={blocks.length} className="rt-list" start={list.start}>
          {items}
        </ol>
      ) : (
        <ul key={blocks.length} className="rt-list">
          {items}
        </ul>
      ),
    );
    list = null;
  };
  for (const line of lines) {
    // A request's kept page: a button that brings it up in the person's browser.
    const page = request != null ? BROWSER_LINE.exec(line) : null;
    if (page) {
      pages.push(<BrowserButton key={pages.length} url={page[1]} request={request!} browser={page[2] ? Number(page[2]) : undefined} />);
      continue;
    }
    // A line that's only where to connect something: a big button to it.
    const place = onSettings ? SETTINGS_LINE.exec(line) : null;
    if (place) {
      flushPara();
      flushList();
      const name = place[1].trim();
      blocks.push(
        <button key={blocks.length} className="rt-settings" onClick={() => onSettings!(name)}>
          Open {name} in Settings
        </button>,
      );
      continue;
    }
    const num = NUMBERED.exec(line);
    const bul = BULLET.exec(line);
    if (num || bul) {
      flushPara();
      const kind = num ? 'ol' : 'ul';
      if (list?.kind !== kind) {
        flushList();
        list = { kind, start: num ? Number(num[1]) : 1, items: [] };
      }
      list!.items.push(num ? num[2] : bul![1]);
    } else if (!line.trim()) {
      flushPara();
      flushList();
    } else if (list && /^\s{2,}/.test(line)) {
      list.items[list.items.length - 1] += ` ${line.trim()}`; // a step's continuation
    } else {
      flushList();
      para.push(line);
    }
  }
  flushPara();
  flushList();
  return (
    <>
      {blocks}
      {pages}
    </>
  );
}
