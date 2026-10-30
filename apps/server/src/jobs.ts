import { readFile } from 'node:fs/promises';
import { integrationToolIds, liveEventIds } from './integrations/index.js';
import { customize, type Build } from './builder.js';
import { scanFleet } from './fleet.js';
import { compose, kpiLabels, listIds, readMeta, save, writeMeta } from './files.js';
import { loadPerson, loadProfile } from './org.js';
import { availableModels } from './models/connections.js';
import { setChoices } from './models/choice.js';
import { pickDefaults } from './runner/defaults.js';
import { agencyStopped } from './runner/run.js';

// Setting up pack agents (docs/agent-creation.md). Adding a pack saves each
// agent's generic files at once, so it exists and is valid straight away; this
// then rewrites them for the organisation and fleet in the background. The
// server owns the work - it carries on if the app closes, and resumes after a
// restart. An agent is not run until its set-up has finished. While the whole
// agency is stopped, nothing new is started (one under way finishes); Resume
// agency picks the queue back up.

const PACKS = new URL('../packs/', import.meta.url);
const MAX_ATTEMPTS = 3;
const CONCURRENCY = 3;

const queue: string[] = [];
const active = new Set<string>();
// How many set-ups wait their turn (or for the agency to be resumed).
export const waitingSetups = () => queue.length;

export async function packTemplate(packId: string, index: number): Promise<{ build: Build; packName: string }> {
  if (!/^[a-z0-9-]+$/.test(packId)) throw new Error('Unknown pack');
  const builds = JSON.parse(await readFile(new URL(`${packId}.json`, PACKS), 'utf8')) as Build[];
  return { build: builds[index], packName: packId.charAt(0).toUpperCase() + packId.slice(1) };
}

export function enqueue(id: string) {
  if (active.has(id) || queue.includes(id)) return;
  queue.push(id);
  pump();
}

function pump() {
  while (active.size < CONCURRENCY && queue.length && !agencyStopped()) {
    const id = queue.shift()!;
    active.add(id);
    run(id).finally(() => {
      active.delete(id);
      pump();
    });
  }
}

async function run(id: string) {
  const meta = await readMeta(id);
  if (!meta || meta.status !== 'setting-up' || !meta.setup) return;
  const { packId, index, person, org } = meta.setup;
  try {
    const { build, packName } = await packTemplate(packId, index);
    // Every other agent counts, including packmates still being set up, so
    // they all converge on the same tool ids.
    const fleet = await scanFleet(id);
    const ctx = { person: await loadPerson(person), profile: org ? await loadProfile(org) : null, fleet, models: await availableModels() };
    const custom = await customize(ctx, build, packName);
    const files = compose(custom, id, new Set([...fleet.tools.map(t => t.id), ...integrationToolIds()]), ctx.models, new Set(liveEventIds()));
    // Deleted while it was being set up: don't bring it back.
    if (!(await readMeta(id))) return;
    await setChoices(id, pickDefaults(ctx.models, 'strong', files.models));
    // Still theirs: the owner and organisation carry over from set-up.
    await save(files, { name: files.name, department: files.department, output: kpiLabels(files.kpi), status: 'ready', owner: meta.owner ?? person, org: meta.org ?? org });
    // What its tailoring added that nothing provides yet goes to the Agency Engineer.
    const { requestWhatsMissing } = await import('./agents.js');
    await requestWhatsMissing(files);
    console.log(`set up ${id}`);
  } catch (e) {
    const attempts = meta.setup.attempts + 1;
    console.error(`setting up ${id} failed (attempt ${attempts}):`, (e as Error).message);
    if (!(await readMeta(id))) return;
    if (attempts >= MAX_ATTEMPTS) {
      // Give up and keep the generic files: the agent still works, just not tailored.
      await writeMeta(id, { ...meta, status: 'generic', setup: { ...meta.setup, attempts } });
    } else {
      await writeMeta(id, { ...meta, setup: { ...meta.setup, attempts } });
      setTimeout(() => enqueue(id), 5000 * attempts);
    }
  }
}

// On boot, and when the agency is resumed: pick up anything a restart or a stop held back.
export async function resume() {
  for (const id of await listIds()) if ((await readMeta(id))?.status === 'setting-up') enqueue(id);
  pump();
}
