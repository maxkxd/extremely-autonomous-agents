import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Where this agency keeps everything: apps/server/data, or EAA_DATA_DIR. A
// machine hosting an organisation runs a second agency beside the person's
// own, with its own folder (hosting.ts).
export const DATA_DIR = process.env.EAA_DATA_DIR ? resolve(process.env.EAA_DATA_DIR) : join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
