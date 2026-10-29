// Text with its web addresses as links (agents' and the Agency Engineer's
// messages). Only http(s) addresses; punctuation that ends a sentence stays
// out of the link. Opens in the browser, never in the app.
const URL_RE = /https?:\/\/[^\s<>"']+/g;
const TRAILING = /[.,;:!?)\]]+$/;

export function Linkify({ text }: { text: string }) {
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    const raw = m[0];
    const url = raw.replace(TRAILING, '');
    const at = m.index ?? 0;
    parts.push(text.slice(last, at));
    parts.push(
      <a key={at} className="text-link" href={url} target="_blank" rel="noreferrer noopener">
        {url}
      </a>,
    );
    last = at + url.length;
  }
  parts.push(text.slice(last));
  return <>{parts}</>;
}
