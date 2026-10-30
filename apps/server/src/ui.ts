import { readFile } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import { extname, join, normalize, relative, resolve } from 'node:path';

// The app itself, in a packaged build (apps/electron): its built files
// (apps/desktop/dist) served by this agency, so /api is the same address and
// there's no Vite. Only when EAA_UI_DIR says where they are - in development
// Vite serves them. A path that isn't a file is the app's own page (it routes
// itself), so a reload anywhere still opens it.

const UI_DIR = process.env.EAA_UI_DIR ? resolve(process.env.EAA_UI_DIR) : null;

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
};

export const servesUi = () => !!UI_DIR;

// True when it answered.
export async function serveUi(res: ServerResponse, pathname: string): Promise<boolean> {
  if (!UI_DIR) return false;
  let path: string;
  try {
    path = normalize(join(UI_DIR, decodeURIComponent(pathname)));
  } catch {
    return false;
  }
  // Nothing outside its folder.
  if (relative(UI_DIR, path).startsWith('..')) return false;
  const file = await readFile(path).catch(() => null);
  if (file) {
    // Built assets have hashed names: kept; the page itself is always fresh, so an update shows at once.
    const cache = /[\\/]assets[\\/]/.test(path) ? 'public, max-age=31536000, immutable' : 'no-cache';
    res.writeHead(200, { 'content-type': TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream', 'cache-control': cache });
    res.end(file);
    return true;
  }
  if (extname(pathname)) return false; // a missing file, not a page
  const page = await readFile(join(UI_DIR, 'index.html')).catch(() => null);
  if (!page) return false;
  res.writeHead(200, { 'content-type': TYPES['.html'], 'cache-control': 'no-cache' });
  res.end(page);
  return true;
}
