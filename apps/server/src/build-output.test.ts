import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildOutputForTests, unaskedTools } from './builder.js';

// A build as Claude writes it (three lists as JSON text, to keep the
// structured-output grammar under its size limit), turned back into a Build.

const base = {
  name: 'Lead Research',
  department: 'sales' as const,
  charter: '# CHARTER - Lead Research',
  models: [],
  tools: [{ id: 'web.web_search', tier: 'T0' as const, why: 'finding leads' }],
  new_tools: [],
  events: [],
  kpi: [{ id: 'web.web_search', label: 'searches' }],
  max_runs_per_day: 20,
  ferocity: { chill_every_hours: 24, steady_every_hours: 16, driven_every_hours: 12, relentless_every_hours: 6, driven_soft_floor: 3, relentless_floor: 20, apocalyptic_floor: 80, counts: ['web.web_search'], hint: '', extra_effort: '' },
  profile_notes: [],
  person_notes: [],
  report_place: '',
};

test('the JSON-text lists come back as lists', () => {
  const b = buildOutputForTests.fromOutput({
    ...base,
    approval_hours: '[{"id":"mail.send","hours":12}]',
    natural_limits: '[{"tool":"mail.send","max":5,"per_hours":24,"why":"no spam"}]',
    new_events: '[]',
  });
  assert.deepEqual(b.approval_hours, [{ id: 'mail.send', hours: 12 }]);
  assert.deepEqual(b.natural_limits, [{ tool: 'mail.send', max: 5, per_hours: 24, why: 'no spam' }]);
  assert.deepEqual(b.new_events, []);
  assert.deepEqual(b.tools, base.tools, 'everything else untouched');
});

test('a list that is not valid comes back empty rather than breaking the build', () => {
  const b = buildOutputForTests.fromOutput({ ...base, approval_hours: 'not json', natural_limits: '[{"tool":1}]', new_events: '' });
  assert.deepEqual([b.approval_hours, b.natural_limits, b.new_events], [[], [], []]);
});

test('the schema Claude gets keeps the three lists as text, everything else as before', () => {
  const shape = buildOutputForTests.schema.shape;
  for (const k of ['approval_hours', 'natural_limits', 'new_events'] as const) assert.equal(shape[k].type, 'string', k);
  assert.equal(shape.tools.type, 'array');
});

test("a higher ferocity level never runs less often than the one below it; the fastest is every 10 minutes", async () => {
  const { ferocityPlan } = await import('./files.js');
  const f = { chill_every_hours: 6, steady_every_hours: 4, driven_every_hours: 2, relentless_every_hours: 3, driven_soft_floor: 1, relentless_floor: 3, apocalyptic_floor: 9, counts: [], hint: '', extra_effort: '' };
  assert.deepEqual(ferocityPlan(f, {}).every_hours, [6, 4, 2, 2]);
  assert.equal(ferocityPlan({ ...f, relentless_every_hours: 0.05 }, {}).every_hours[3], 1 / 6);
});

test("a build holding email or Drive nobody asked for is caught: the person said neither, and neither is connected", () => {
  const turns = [
    { role: 'person' as const, text: "Each week, check our published posts in Sanity for missing SEO descriptions and give me a list to fix." },
    { role: 'builder' as const, text: 'Should I email it to you?' },
  ];
  const tools = (ids: string[]) => ({ tools: ids.map(id => ({ id, tier: 'T1' as const, why: 'x' })) });
  assert.deepEqual(unaskedTools(tools(['sanity.list_posts', 'gmail.send_to_me', 'docs.create_document', 'files.write_file']), turns, new Set()), ['gmail.send_to_me', 'docs.create_document']);
  // Asked for (the builder's own question doesn't count as asking), or already connected: kept.
  assert.deepEqual(unaskedTools(tools(['gmail.send_to_me']), [{ role: 'person', text: 'Email me the list each Monday.' }], new Set()), []);
  assert.deepEqual(unaskedTools(tools(['gmail.send_to_me']), turns, new Set(['gmail.send_to_me'])), []);
  // "docs" as a word only - not inside another one.
  assert.deepEqual(unaskedTools(tools(['docs.append_to_document']), [{ role: 'person', text: 'Keep notes in a Google Doc.' }], new Set()), []);
});

test('files on the computer always start at approval, and only when the person spoke of a folder or the computer', () => {
  const b = buildOutputForTests.fromOutput({
    ...base,
    tools: [...base.tools, { id: 'computer_files.write_file', tier: 'T0' as const, why: 'reports' }],
    approval_hours: '[]',
    natural_limits: '[]',
    new_events: '[]',
  });
  assert.equal(b.tools.find(t => t.id === 'computer_files.write_file')?.tier, 'T2');
  const said = (text: string) => [{ role: 'person' as const, text }];
  assert.deepEqual(unaskedTools(b, said('Tell me every morning about new grants'), new Set()), ['computer_files.write_file']);
  assert.deepEqual(unaskedTools(b, said('Save it in my Documents folder please'), new Set()), []);
});

test("a made-up 'narrower' computer_files tool becomes the built-in write, at approval", () => {
  const b = buildOutputForTests.fromOutput({
    ...base,
    tools: [...base.tools, { id: 'computer_files.write_tender_summary', tier: 'T1' as const, why: 'skip approval' }, { id: 'computer_files.write_file', tier: 'T2' as const, why: 'x' }],
    new_tools: [{ server: 'computer_files', name: 'write_tender_summary', description: 'x', input_schema: '{}', how_it_works: 'x' }],
    kpi: [{ id: 'computer_files.write_tender_summary', label: 'summaries saved' }],
    ferocity: { ...base.ferocity, counts: ['computer_files.write_tender_summary'] },
    approval_hours: '[]',
    natural_limits: '[]',
    new_events: '[]',
  });
  assert.deepEqual(b.tools.filter(t => t.id.startsWith('computer_files.')).map(t => [t.id, t.tier]), [['computer_files.write_file', 'T2']]);
  assert.deepEqual(b.new_tools, []);
  assert.equal(b.kpi[0].id, 'computer_files.write_file');
  assert.deepEqual(b.ferocity.counts, ['computer_files.write_file']);
});
