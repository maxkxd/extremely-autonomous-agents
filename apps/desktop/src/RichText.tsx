import { Fragment } from 'react';

// Agents' and the Agency Engineer's text, made easy to follow: numbered steps as a
// numbered list (also when they're written inline, "1. Do this. 2. Then that."),
// "- " lines as bullets, `code` set apart, web addresses as links, and other
// requests ("request #41", "#41") as links that take you to them.

type Ref = { onRequest?: (id: number) => void; canOpen?: (id: number) => boolean };

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
function Inline({ text, refs }: { text: string; refs: Ref }) {
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
          <span key={at} className="rt-ref" title="That request isn't on the Requests page: it's closed, or the Agency Engineer is still working on it">
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

export function RichText({ text, onRequest, canOpen }: { text: string } & Ref) {
  const refs = { onRequest, canOpen };
  const lines = unfoldSteps(text).split('\n');
  const blocks: React.ReactNode[] = [];
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
  return <>{blocks}</>;
}
