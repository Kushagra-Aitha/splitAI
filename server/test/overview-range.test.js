import assert from 'node:assert/strict';
import test from 'node:test';
import { RangeError422, parseRange } from '../banking/overview.js';

test('bucket defaults to day up to 62 days, then month', () => {
  assert.equal(parseRange({ from: '2026-11-01', to: '2026-11-14' }).bucket, 'day');
  assert.equal(parseRange({ from: '2026-09-15', to: '2026-11-15' }).bucket, 'day');
  assert.equal(parseRange({ from: '2026-06-01', to: '2026-11-14' }).bucket, 'month');
  assert.equal(parseRange({ from: '2026-11-01', to: '2026-11-30', bucket: 'week' }).bucket, 'week');
});

test('a single day is a valid range', () => {
  assert.deepEqual(parseRange({ from: '2026-11-14', to: '2026-11-14' }), {
    from: '2026-11-14', to: '2026-11-14', bucket: 'day', days: 1,
  });
});

test('bad input is a 422-style RangeError422, never a silent default', () => {
  for (const input of [
    {},
    { from: '2026-11-01' },
    { from: '2026-11-1', to: '2026-11-14' },
    { from: '2026-02-30', to: '2026-03-01' },
    { from: '2026-11-14', to: '2026-11-01' },
    { from: '2026-11-01', to: '2026-11-14', bucket: 'year' },
    { from: '2026-01-01', to: '2026-12-31', bucket: 'day' },
    { from: '2020-01-01', to: '2026-12-31', bucket: 'month' },
    { from: "2026-11-01'; drop table x;--", to: '2026-11-14' },
  ]) {
    assert.throws(() => parseRange(input), RangeError422, JSON.stringify(input));
  }
});
