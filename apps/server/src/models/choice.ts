import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Which models each agent runs on (docs/model-connections.md): up to three,
// in order of preference, each a model on one connection with an effort
// level. The runner uses the first one that isn't cooling down after a
// failure (see health.ts); the card shows the first.

export const EFFORTS = ['low', 'medium', 'high', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];
export type ModelChoice = { connection: string; model: string; effort: Effort };

export const MAX_CHOICES = 3;

const FILE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'agent-models.json');

async function readAll(): Promise<Record<string, ModelChoice[]>> {
  try {
    return JSON.parse(await readFile(FILE, 'utf8')) as Record<string, ModelChoice[]>;
  } catch {
    return {};
  }
}

let writing = Promise.resolve();
function writeAll(fn: (all: Record<string, ModelChoice[]>) => void) {
  writing = writing.then(async () => {
    const all = await readAll();
    fn(all);
    await mkdir(dirname(FILE), { recursive: true });
    await writeFile(FILE, JSON.stringify(all, null, 2) + '\n');
  });
  return writing;
}

export const allChoices = readAll;

// Keeps only well-formed, distinct choices, at most three.
export function cleanChoices(input: unknown): ModelChoice[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const out: ModelChoice[] = [];
  for (const c of input as Partial<ModelChoice>[]) {
    if (!c || typeof c.connection !== 'string' || typeof c.model !== 'string' || !c.connection || !c.model) continue;
    const key = `${c.connection}/${c.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ connection: c.connection, model: c.model, effort: EFFORTS.includes(c.effort as Effort) ? (c.effort as Effort) : 'medium' });
    if (out.length === MAX_CHOICES) break;
  }
  return out;
}

export async function setChoices(agentId: string, choices: unknown) {
  const clean = cleanChoices(choices);
  await writeAll(all => {
    if (clean.length) all[agentId] = clean;
    else delete all[agentId];
  });
  return clean;
}

export const removeChoices = (agentId: string) =>
  writeAll(all => {
    delete all[agentId];
  });
