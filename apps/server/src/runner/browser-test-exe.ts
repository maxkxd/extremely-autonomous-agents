import { existsSync } from 'node:fs';
import { join } from 'node:path';

// For the page-view tests only (browser-page.test.ts, browser-fill.test.ts): an Edge or
// Chrome on this machine to run headless against. The app itself never starts a
// browser: agents work in the person's own, through the extension.
export function testBrowserExe(): string | null {
  const env = process.env;
  if (env.EAA_TEST_BROWSER && existsSync(env.EAA_TEST_BROWSER)) return env.EAA_TEST_BROWSER;
  const candidates =
    process.platform === 'win32'
      ? [
          join(env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
          join(env.ProgramFiles ?? 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
          join(env.ProgramFiles ?? 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
          join(env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
          join(env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        ]
      : process.platform === 'darwin'
        ? ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
        : ['/usr/bin/microsoft-edge', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium'];
  return candidates.find(p => p && existsSync(p)) ?? null;
}
