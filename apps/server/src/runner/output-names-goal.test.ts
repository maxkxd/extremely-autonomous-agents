import '../test-data-dir.js';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { parse } from 'yaml';
import { DATA } from '../files.js';
import { addOutput } from './output-names.js';

test('a new goal whose tools all count toward another goal is refused, not reported saved', async () => {
  const id = 'zz-taken';
  const dir = join(DATA, id);
  await mkdir(dir, { recursive: true });
  const kpi = 'output:\n  - action: acme-crm.createrecord\n    label: leads added\n';
  await writeFile(join(dir, 'KPI.yaml'), kpi);
  await writeFile(join(dir, 'TOOLS.yaml'), 'tool_tiers:\n  acme-crm.createrecord: T1\n  acme-crm.sendreport: T1\n');
  await writeFile(join(dir, 'meta.json'), JSON.stringify({ name: 'Taken', department: 'sales', output: ['leads added'], status: 'ready' }));
  const rows = async () => (parse(await readFile(join(dir, 'KPI.yaml'), 'utf8')) as { output: { action: string; label: string }[] }).output;

  await assert.rejects(addOutput(id, 'reports written', ['acme-crm.createrecord']), /acme-crm\.createrecord already counts toward "leads added"/);
  assert.equal(await readFile(join(dir, 'KPI.yaml'), 'utf8'), kpi);

  // A goal it has, named with its own tool again: nothing to add, and no complaint.
  await addOutput(id, 'leads added', ['acme-crm.createrecord']);
  assert.equal(await readFile(join(dir, 'KPI.yaml'), 'utf8'), kpi);

  // One free tool is enough: the new goal gets that one.
  await addOutput(id, 'reports written', ['acme-crm.createrecord', 'acme-crm.sendreport']);
  assert.deepEqual(await rows(), [
    { action: 'acme-crm.createrecord', label: 'leads added' },
    { action: 'acme-crm.sendreport', label: 'reports written' },
  ]);
  await rm(dir, { recursive: true, force: true });
});
