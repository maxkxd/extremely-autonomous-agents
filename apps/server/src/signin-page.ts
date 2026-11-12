// The page a sign-in lands on, in the browser window the service opened: either
// waiting for the app to finish it (signin-handoff.ts) or already done (index.ts).
// While waiting the heading's letters ripple like a wave; once connected they
// settle and float together; if it fails they just stop.

const LOGO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACwAAAAsCAYAAAAehFoBAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAANsSURBVFhH7dVLbBtVFABQq0L8qm4qFi0fVQJBJTYUqXxUUWbGxs7c9zz3zfiDaPlIVC2brhClizSTSZMCqipU6CIbCgvYsECIRSWEyrKwAAlVfKImcRyIkzjzsx03SdMAvmgGWrkjEBsHAnpHehu/e2fuvHv1nEpJkiRJkiRJ/xE+4haXiV0+E883mXWkxQsvLbLinnr2uc3J2A0n0K27G9x6ts3N9xpMfNlg4jMfxEiTodbKlbYm4zeUuHiwDgdMXPABf/GY6CwAXnQBTwcgii3dvC+Zs2E0WGFHwPBln4lv1kSJqLiPmtykOhiXPMAPfMDDAcPHOohbkrn/utW+vp0Bw2Mew2+vYDEunqynqRF9gI51F8T5aIwaujBWhLgnmf+PyL5ycbPiTJp7R2b3dP++BrA74HjKAzG5ZBSoY5Yp6sAqFulyvkALurHy+xgZ74YgDjZ1fLhTKt3W/Yx1ow1Ud6qDlU8zI7PfqU716COvew9071/R85kQzLM+w/llo0ArRjE+9Ra3KOpEtHwmaAGw5oJxzgNhB3kzt2RZ27uf01uOs0kdnHgHTl8lbahKqj3xheb8eGTXycX7r4VQKnVTG/JFn+FHLuBiVGh82oBUB6SACYq6EXWhnbeorhuXXcCvPMDRAPDFdt58ouc3kjIwdlAdmlrOnJijp15bIGVg/FdtcPKCNlR99d6Tq9eLX0a8M+TmIR/EeRdwLWQmzeoGzf2x5nWDXMC4G1TaTz+LEoVcfDKv44M3vrEHnuz/4UB6eKajHBsj1R6n7BsesbfWKDNSI9WZev/xEzN3dccvsfI2D8THrbx1veBoZK5iKRqVVsjEaINbD3Xn9IzaP8a1oWotM1yLTzh9/CdS7cqk6lTOpO2prOJcuiPl0KbuHBfwhZALz2OCFvNWPBIBw+mAC3uZl274uJ5S7PGBvlPt+EQVe7yiOlNn0sentbLz/c3J2GtcEG9Ht0e0orkNmfi6yc0D9Wx2/f7+9/aPbdfsyofp4Zqbdqqjql3JlB36yyIjM7nc1oDh51TeH7c/AHEu5IIl43ou78zdrg1W9inO9DOKM31rcv/PzOT4o01uetGNEHLzrA+4OxmzbpzEPP6dOcBDDS4qS0bxzXnGdiT3N4wJXb/F14VRB+Ooy8rbkvuSJEmSJEnS/9FvuPrO5tXAaN4AAAAASUVORK5CYII=';

export type SignInState = { done: false } | { done: true; ok: boolean; message: string };

const escape = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const heading = (s: { done: boolean; ok?: boolean }) => (!s.done ? 'Signing in' : s.ok ? 'Connected' : 'Not connected');
const title = (s: { done: boolean; ok?: boolean }) => `${heading(s)} · EXTREMELY`;
const letters = (text: string) =>
  [...text].map((c, i) => `<span style="--i:${i}">${c === ' ' ? '&nbsp;' : escape(c)}</span>`).join('');

// `pollState`: when set, the page asks /api/oauth/held/status for that state
// until the app says how it went.
export function signInPage(s: SignInState, pollState?: string) {
  const cls = !s.done ? 'wave' : s.ok ? 'float' : 'still';
  const message = s.done ? s.message : 'Finishing in the app…';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(title(s))}</title>
<link rel="icon" type="image/png" href="${LOGO}">
<style>
  :root { color-scheme: dark; }
  html, body { margin: 0; height: 100%; }
  body {
    display: grid; place-items: center; text-align: center;
    background: radial-gradient(ellipse at 50% 42%, #1c1c1c 0%, #141414 60%);
    color: #e6e6e6; font-family: 'IBM Plex Sans', 'Segoe UI', system-ui, sans-serif;
  }
  .card { padding: 24px; }
  .logo { width: 44px; height: 44px; display: block; margin: 0 auto 22px; opacity: 0.95; }
  h1 { transition: opacity 0.3s; font-size: 26px; font-weight: 600; letter-spacing: 0.01em; margin: 0 0 10px; white-space: nowrap; }
  h1 span { display: inline-block; transition: transform 0.6s ease-out, opacity 0.4s; }
  p { color: #8a8a8a; margin: 0; font-size: 14px; min-height: 1.4em; transition: opacity 0.4s; }

  /* Waiting: a Mexican wave across the letters. */
  h1.wave span { animation: wave 1.6s ease-in-out infinite; animation-delay: calc(var(--i) * 0.09s); }
  @keyframes wave {
    0%, 55%, 100% { transform: translateY(0); }
    25% { transform: translateY(-9px); }
  }

  /* Connected: the letters land, then the word floats as one. */
  h1.float span { animation: land 0.45s ease-out both; animation-delay: calc(var(--i) * 0.03s); }
  h1.float { animation: float 3.2s ease-in-out 0.6s infinite; }
  @keyframes land { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
  @keyframes float { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-6px); } }

  h1.still span { animation: land 0.45s ease-out both; }
  h1.still { color: #f19a9c; }

  .swap { opacity: 0; }
  @media (prefers-reduced-motion: reduce) {
    h1, h1 span { animation: none !important; }
  }
</style></head>
<body><div class="card">
<img class="logo" src="${LOGO}" alt="">
<h1 id="h" class="${cls}">${letters(heading(s))}</h1>
<p id="p">${escape(message)}</p>
</div>
<script>
const letters = t => [...t].map((c, i) => '<span style="--i:' + i + '">' + (c === ' ' ? '&nbsp;' : c.replace(/[&<>"]/g, x => '&#' + x.charCodeAt(0) + ';')) + '</span>').join('');
const h = document.getElementById('h'), p = document.getElementById('p');
function finish(r) {
  const word = r.ok ? 'Connected' : 'Not connected';
  document.title = word + ' · EXTREMELY';
  h.classList.add('swap'); p.classList.add('swap');
  setTimeout(() => {
    h.className = r.ok ? 'float' : 'still';
    h.innerHTML = letters(word);
    p.textContent = r.message;
    p.classList.remove('swap');
  }, 300);
  if (r.ok) setTimeout(() => window.close(), 2400);
}
${
  pollState
    ? `const state = ${JSON.stringify(pollState)};
const tick = async () => {
  const r = await fetch('/api/oauth/held/status?state=' + encodeURIComponent(state)).then(r => r.json()).catch(() => null);
  if (r && r.done) return finish(r);
  setTimeout(tick, 1000);
};
tick();`
    : s.done && s.ok
      ? 'setTimeout(() => window.close(), 2400);'
      : ''
}
</script></body></html>`;
}
