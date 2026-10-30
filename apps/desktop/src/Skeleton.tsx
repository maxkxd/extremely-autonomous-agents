// Where something not known yet goes while it loads (styles.css .skel): a
// shimmering shape the size of what replaces it - never a made-up value, a
// zero, or an empty-state message that isn't true yet.
export const Skel = ({ w, h, r }: { w: number | string; h?: number; r?: number }) => (
  <span className="skel" style={{ width: w, height: h, borderRadius: r }} aria-hidden />
);

// A few lines of text, the last one shorter.
export function SkelLines({ lines = 3, h = 12 }: { lines?: number; h?: number }) {
  return (
    <span className="skel-lines" aria-hidden>
      {Array.from({ length: lines }, (_, i) => (
        <Skel key={i} w={i === lines - 1 ? '55%' : i % 2 ? '88%' : '100%'} h={h} />
      ))}
    </span>
  );
}

// For screen readers: what's loading.
export const Loading = ({ what }: { what: string }) => <span className="sr-only">Loading {what}</span>;

// A settings form not in yet: a few labelled fields.
export function SkelFields({ n = 3, what }: { n?: number; what: string }) {
  return (
    <div className="skel-fields" aria-busy>
      <Loading what={what} />
      {Array.from({ length: n }, (_, i) => (
        <span key={i} className="skel-field" aria-hidden>
          <Skel w={i % 2 ? 90 : 120} h={11} />
          <Skel w="100%" h={i === n - 1 ? 64 : 36} r={8} />
        </span>
      ))}
    </div>
  );
}

// A list not in yet: rows the height of its own.
export function SkelRows({ n = 4, h = 44, what }: { n?: number; h?: number; what: string }) {
  return (
    <div className="skel-rows" aria-busy>
      <Loading what={what} />
      {Array.from({ length: n }, (_, i) => (
        <Skel key={i} w="100%" h={h} r={10} />
      ))}
    </div>
  );
}
