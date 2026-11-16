import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dbNotUpYet, whenDbIsUp } from './db.js';

const failure = (code: string) => Object.assign(new Error(`connect ${code}`), { code });
const noSleep = { sleep: async () => {} };

test('a database that is not up yet is waited for, then used', async () => {
  let tries = 0;
  const waits: number[] = [];
  const result = await whenDbIsUp(async () => {
    if (++tries < 4) throw failure(tries === 1 ? 'ENOTFOUND' : 'ECONNREFUSED');
    return 'ok';
  }, { sleep: async ms => void waits.push(ms) });
  assert.equal(result, 'ok');
  assert.equal(tries, 4);
  assert.deepEqual(waits, [1000, 2000, 4000], 'the wait doubles each time');
});

test('any other error is thrown straight away', async () => {
  let tries = 0;
  await assert.rejects(
    whenDbIsUp(async () => {
      tries++;
      throw failure('28P01');
    }, noSleep),
    /28P01/,
  );
  assert.equal(tries, 1);
});

test('it gives up with the last error after the maximum wait', async () => {
  let slept = 0;
  let tries = 0;
  await assert.rejects(
    whenDbIsUp(async () => {
      tries++;
      throw failure('ENOTFOUND');
    }, { maxWaitMs: 20_000, sleep: async ms => void (slept += ms) }),
    /ENOTFOUND/,
  );
  assert.equal(slept, 20_000);
  assert.ok(tries > 1);
});

test('a refused connection to several addresses counts as not up yet', () => {
  const aggregate = Object.assign(new AggregateError([failure('ECONNREFUSED'), failure('ECONNREFUSED')]), {});
  assert.equal(dbNotUpYet(aggregate), true);
  assert.equal(dbNotUpYet(failure('ENOTFOUND')), true);
  assert.equal(dbNotUpYet(new Error('syntax error')), false);
  assert.equal(dbNotUpYet(null), false);
});
