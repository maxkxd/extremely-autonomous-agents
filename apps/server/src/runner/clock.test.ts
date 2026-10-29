import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startOfDay, startOfMonth } from './clock.js';

test("days start at the host's midnight, wherever the server is", () => {
  // 29 Oct 2026, 02:30 UTC: already the 29th in Sydney (13:30), still the 28th in New York (22:30).
  const t = Date.UTC(2026, 9, 29, 2, 30);
  assert.equal(new Date(startOfDay(t, 'Australia/Sydney')).toISOString(), '2026-10-28T13:00:00.000Z'); // AEDT, UTC+11
  assert.equal(new Date(startOfDay(t, 'America/New_York')).toISOString(), '2026-10-28T04:00:00.000Z'); // EDT, UTC-4
  assert.equal(new Date(startOfMonth(t, 'Australia/Sydney')).toISOString(), '2026-09-30T14:00:00.000Z'); // 1 Oct, AEST, UTC+10
  // A daylight-saving change day: Sydney's clocks went forward on 4 Oct 2026.
  assert.equal(new Date(startOfDay(Date.UTC(2026, 9, 4, 12), 'Australia/Sydney')).toISOString(), '2026-10-03T14:00:00.000Z');
});
