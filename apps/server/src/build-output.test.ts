import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildOutputForTests } from './builder.js';

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
