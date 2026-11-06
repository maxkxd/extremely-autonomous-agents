import '../test-data-dir.js';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { parse } from 'yaml';
import { DATA } from '../files.js';
import { applyOutputMoves, movesFor, retargetOutput, sameAction } from './output-names.js';

test('the same action matches across a server prefix and a batch form, and a longer word does not', () => {
  assert.equal(sameAction('crm.create_record', 'acme-crm.acmecrm_createrecords'), true);
  assert.equal(sameAction('crm.update_record', 'acme-crm.acmecrm_updaterecord'), true);
  assert.equal(sameAction('crm.update_record', 'acme-crm.acmecrm_updaterecords'), true);
  assert.equal(sameAction('crm.get_record', 'acme-crm.acmecrm_getrecordcount'), false);
  assert.equal(sameAction('crm.search_records', 'files.write_file'), false);
  const moves = movesFor(
    ['crm.create_record', 'crm.update_record', 'analytics.query'],
    ['acme-crm.acmecrm_createrecords', 'acme-crm.acmecrm_updaterecords', 'acme-crm.acmecrm_updaterecord', 'acme-crm.acmecrm_searchrecords'],
  );
  assert.deepEqual(moves, [
    { from: 'crm.create_record', to: ['acme-crm.acmecrm_createrecords'] },
    { from: 'crm.update_record', to: ['acme-crm.acmecrm_updaterecord', 'acme-crm.acmecrm_updaterecords'] },
  ]);
});

test('a connection going live points the count at the real tools and leaves one it cannot match', async () => {
  const id = 'zz-counted';
  const dir = join(DATA, id);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'KPI.yaml'),
    '# KPI - kept\noutput:\n  - action: crm.create_record\n    label: leads added\n  - action: crm.update_record\n    label: leads enriched\n  - action: files.read_file\n    label: notes\n',
  );
  await writeFile(
    join(dir, 'TOOLS.yaml'),
    [
      '# kept',
      'tool_tiers:',
      '  files.read_file: T0',
      '  acme-crm.acmecrm_createrecords: T1',
      '  acme-crm.acmecrm_updaterecord: T1',
      '  acme-crm.acmecrm_updaterecords: T1',
      'ferocity:',
      '  counts:',
      '    - crm.create_record',
      '    - crm.update_record',
      '    - analytics.query',
      '    - files.read_file',
      '  hint: Keep this hint.',
    ].join('\n'),
  );
  await writeFile(join(dir, 'meta.json'), JSON.stringify({ name: 'Counted', department: 'sales', output: ['leads added'], status: 'ready' }));
  const moved = await retargetOutput(id, ['acme-crm.acmecrm_createrecords', 'acme-crm.acmecrm_updaterecord', 'acme-crm.acmecrm_updaterecords', 'acme-crm.acmecrm_searchrecords']);
  assert.deepEqual(
    moved.moves.map(m => m.from),
    ['crm.create_record', 'crm.update_record'],
  );
  assert.deepEqual(moved.unmatched, ['analytics.query']);
  const kpi = parse(await readFile(join(dir, 'KPI.yaml'), 'utf8')) as { output: { action: string; label: string }[] };
  assert.match(await readFile(join(dir, 'KPI.yaml'), 'utf8'), /# KPI - kept/);
  assert.deepEqual(kpi.output, [
    { action: 'acme-crm.acmecrm_createrecords', label: 'leads added' },
    { action: 'acme-crm.acmecrm_updaterecord', label: 'leads enriched' },
    { action: 'acme-crm.acmecrm_updaterecords', label: 'leads enriched' },
    { action: 'files.read_file', label: 'notes' },
  ]);
  const tools = await readFile(join(dir, 'TOOLS.yaml'), 'utf8');
  assert.match(tools, /Keep this hint/);
  const doc = parse(tools) as { ferocity: { counts: string[] } };
  assert.deepEqual(doc.ferocity.counts, [
    'acme-crm.acmecrm_createrecords',
    'acme-crm.acmecrm_updaterecord',
    'acme-crm.acmecrm_updaterecords',
    'analytics.query',
    'files.read_file',
  ]);
  // A second pass has nothing left that those tools match.
  assert.deepEqual((await retargetOutput(id, ['acme-crm.acmecrm_createrecords'])).moves, []);
  await assert.rejects(
    applyOutputMoves(id, [{ from: 'acme-crm.acmecrm_createrecords', to: ['files.write_file'] }]),
    /isn't output/,
  );
  await assert.rejects(applyOutputMoves(id, [{ from: 'no.such', to: ['acme-crm.acmecrm_createrecords'] }]), /isn't what/);
  await rm(dir, { recursive: true, force: true });
});
