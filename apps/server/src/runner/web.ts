import { extractText, getDocumentProxy } from 'unpdf';
import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import { safeFetch } from './net.js';
import { registerTools } from './tools.js';

// Web research tools that need no key (docs/integrations.md): reading a page.
// Search comes from whichever search integration is connected; browsing from
// browser.ts.

const BLOCK = new Set(['P', 'DIV', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'LI', 'UL', 'OL', 'TABLE', 'TR', 'BLOCKQUOTE', 'PRE', 'FIGURE', 'FIGCAPTION', 'BR', 'HR', 'DT', 'DD']);
const HEADING = /^H[1-6]$/;

// HTML to plain text that keeps its shape: paragraphs, headings, list items, cells.
function textOf(root: Node): string {
  const out: string[] = [];
  const walk = (n: Node) => {
    if (n.nodeType === 3) {
      out.push((n.textContent ?? '').replace(/\s+/g, ' '));
      return;
    }
    if (n.nodeType !== 1) return;
    const el = n as Element;
    const tag = el.tagName;
    if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'TEMPLATE', 'IFRAME'].includes(tag)) return;
    const head = HEADING.test(tag);
    if (head) out.push(`\n\n${'#'.repeat(Number(tag[1]))} `);
    else if (tag === 'LI') out.push('\n- ');
    else if (tag === 'TD' || tag === 'TH') out.push(' | ');
    else if (BLOCK.has(tag)) out.push('\n');
    el.childNodes.forEach(walk);
    if (head || BLOCK.has(tag)) out.push('\n');
  };
  walk(root);
  return out
    .join('')
    // Empty table cells leave runs of separators: keep one, drop bare ones.
    .replace(/(\|\s*){2,}/g, '| ')
    .replace(/^\s*\|\s*$/gm, '')
    .replace(/^\s*\|\s*/gm, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export type Page = { title: string; text: string; links: { text: string; url: string }[] };

// A page's main content as readable text, and its links (absolute, http(s)).
export function readable(html: string, baseUrl: string): Page {
  const { document } = parseHTML(html);
  const links: Page['links'] = [];
  const seen = new Set<string>();
  for (const a of [...document.querySelectorAll('a[href]')]) {
    try {
      const url = new URL(a.getAttribute('href')!, baseUrl);
      if (!/^https?:$/.test(url.protocol)) continue;
      url.hash = '';
      const text = (a.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (!text || seen.has(url.href)) continue;
      seen.add(url.href);
      links.push({ text: text.slice(0, 100), url: url.href });
    } catch {
      // not a usable link
    }
  }
  const title = (document.querySelector('title')?.textContent ?? '').trim();
  let main: Node | null = null;
  try {
    const article = new Readability(parseHTML(html).document as unknown as Document).parse();
    if (article?.content && (article.textContent ?? '').trim().length > 200) main = parseHTML(`<main>${article.content}</main>`).document.querySelector('main');
  } catch {
    // Readability couldn't make sense of it: fall back to the whole body.
  }
  const text = textOf((main ?? document.body ?? document.documentElement) as unknown as Node);
  return { title, text, links };
}

const MAX_BYTES = 5_000_000;

// A PDF's text, page by page. A scanned PDF (images, no text layer) says so.
async function pdfText(bytes: Buffer, url: string, cut: (s: string) => string): Promise<string> {
  if (bytes.length > MAX_BYTES) throw new Error(`Too large to read (${Math.round(bytes.length / 1e6)} MB).`);
  let pages: string[];
  try {
    const doc = await getDocumentProxy(new Uint8Array(bytes));
    pages = (await extractText(doc, { mergePages: false })).text as string[];
  } catch {
    throw new Error("It's a PDF that couldn't be read (damaged, or password-protected).");
  }
  const n = `${pages.length} page${pages.length === 1 ? '' : 's'}`;
  if (!pages.some(p => p.trim())) return `URL: ${url}\n\nA PDF of ${n} with no text in it - probably scanned images.`;
  const text = pages.map((p, i) => `--- Page ${i + 1} ---\n${p.replace(/[ \t]+\n/g, '\n').trim()}`).join('\n\n');
  return `PDF: ${url} (${n})\n\n${cut(text)}`;
}

export async function fetchPage(url: string, maxChars = 20_000): Promise<string> {
  const { res, url: finalUrl } = await safeFetch(url, {
    headers: {
      'user-agent': 'Mozilla/5.0 (compatible; ExtremelyAutonomousAgents/1.0; +https://extremely.agency)',
      accept: 'text/html,application/xhtml+xml,application/json,text/plain;q=0.9,application/pdf;q=0.8,*/*;q=0.5',
    },
  });
  if (!res.ok) throw new Error(`${new URL(finalUrl).host} answered ${res.status}${res.statusText ? ` ${res.statusText}` : ''}.`);
  const type = (res.headers.get('content-type') ?? '').toLowerCase();
  const size = Number(res.headers.get('content-length') ?? 0);
  if (size > MAX_BYTES) throw new Error(`Too large to read (${Math.round(size / 1e6)} MB).`);
  const cut = (s: string) => (s.length > maxChars ? `${s.slice(0, maxChars)}\n[cut off at ${maxChars} characters; ask for more with max_chars]` : s);
  if (/pdf/.test(type) || /\.pdf$/i.test(new URL(finalUrl).pathname)) return pdfText(Buffer.from(await res.arrayBuffer()), finalUrl, cut);
  if (!/html|xml|json|text|javascript/.test(type) && type) throw new Error(`It's a ${type.split(';')[0]} file, not a page.`);
  const body = (await res.text()).slice(0, MAX_BYTES);
  if (!/html|xml/.test(type)) return `URL: ${finalUrl}\n\n${cut(body)}`;
  const page = readable(body, finalUrl);
  const links = page.links.slice(0, 60).map(l => `- ${l.text}: ${l.url}`);
  return [`Title: ${page.title || '(none)'}`, `URL: ${finalUrl}`, '', cut(page.text || '(no readable text on this page)'), '', links.length ? `Links on the page:\n${links.join('\n')}` : ''].join('\n').trim();
}

registerTools([
  {
    id: 'web.fetch_page',
    tier: 'T0',
    description: "Read one public web page or PDF: a page's main text, cleaned of menus and clutter, with its links; a PDF's text, page by page.",
    schema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'The full address, starting http:// or https://' }, max_chars: { type: 'number', description: 'How much text to return (default 20000)' } },
      required: ['url'],
    },
    impl: args => fetchPage(String(args.url ?? ''), Math.min(100_000, Math.max(1000, Number(args.max_chars) || 20_000))),
  },
]);
