import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Tests run against a throwaway data folder, never apps/server/data and the
// real vault with its sign-ins (a dev server may be using it at the same
// time). paths.ts reads EAA_DATA_DIR once, when it's first imported, so a test
// imports this before anything else.
const dir = mkdtempSync(join(tmpdir(), 'eaa-test-'));
process.env.EAA_DATA_DIR = dir;
process.on('exit', () => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // a file still open on Windows: the OS's temp cleanup gets it
  }
});
