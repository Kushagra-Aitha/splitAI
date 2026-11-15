import assert from 'node:assert/strict';
import test from 'node:test';
import { insightRange, validateFactAmounts } from '../assistant/facts.js';

test('insight defaults use the app timezone and report an explicit validated window', () => {
  const now = new Date('2026-12-01T02:00:00Z'); // Still November in New York.
  assert.deepEqual(insightRange(undefined, now), { from: '2026-11-01', to: '2026-11-30', bucket: 'day', days: 30 });
  assert.equal(insightRange(new URLSearchParams('from=2026-01-01&to=2026-11-14')).bucket, 'month');
  for (const params of ['from=2026-02-30', 'from=2026-12-01&to=2026-11-30', 'bucket=hour']) {
    assert.throws(() => insightRange(new URLSearchParams(params), now), (error) => error.status === 422 && error.code === 'INVALID_RANGE');
  }
});

test('financial explanation boundaries reject unsafe cents even in nested aggregates', () => {
  assert.doesNotThrow(() => validateFactAmounts({ spendableCents: null, debts: [{ cents: -42 }], savedCents: Number.MAX_SAFE_INTEGER }));
  for (const cents of [Number.MAX_SAFE_INTEGER + 1, 1.1, NaN, Infinity, '4200']) {
    assert.throws(() => validateFactAmounts({ groups: [{ debts: [{ cents }] }] }), (error) => error.code === 'FINANCIAL_STATE_INVALID');
  }
});
