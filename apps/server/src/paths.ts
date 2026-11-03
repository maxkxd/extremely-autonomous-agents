import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Where this agency keeps everything: apps/server/data, or EAA_DATA_DIR. A
// machine hosting an organization runs a second agency beside the person's
// own, with its own folder (hosting.ts).
export const DATA_DIR = process.env.EAA_DATA_DIR ? resolve(process.env.EAA_DATA_DIR) : join(dirname(fileURLToPath(import.meta.url)), '..', 'data');

// A test never gets the real folder: under node --test it brings its own
// (test-data-dir.ts), or stops here before writing anything.
if (!process.env.EAA_DATA_DIR && process.env.NODE_TEST_CONTEXT) throw new Error('A test reached the real data folder: import test-data-dir.js before anything that reads DATA_DIR.');
