import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAllocation, exactCents, insightsWindow } from '../insights/read.js';

test('insights window contains twelve New York calendar months', () => {
  const window = insightsWindow(new Date('2026-11-15T01:00:00Z'));
  assert.deepEqual(window, {
    from: '2025-12-01',
    to: '2026-11-14',
    months: [
      '2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05',
      '2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11',
    ],
    timeZone: 'America/New_York',
  });
});

test('insight cents reject unsafe or non-integer database values', () => {
  assert.equal(exactCents('9007199254740991'), Number.MAX_SAFE_INTEGER);
  for (const value of [900, '1.5', '9e2', '', '9007199254740992']) {
    assert.throws(() => exactCents(value), (error) => error.code === 'INSIGHTS_STATE_INVALID');
  }
});

test('allocation separates reservations from outflows and labels outside salary', () => {
  const allocation = buildAllocation(
    [{ salaryCents: 100_00 }, { salaryCents: 50_00 }],
    [{ totalCents: 80_00 }, { totalCents: 20_00 }],
    [{ savedCents: 25_00 }],
  );
  assert.deepEqual(allocation, {
    salaryCents: 150_00,
    spendingCents: 100_00,
    goalReservationCents: 25_00,
    unallocatedSalaryCents: 25_00,
    outsideSalaryCents: 0,
    note: 'Allocation view only. Goal savings remain in checking and are not bank outflows.',
  });
  assert.equal(buildAllocation([{ salaryCents: 50_00 }], [{ totalCents: 70_00 }], []).outsideSalaryCents, 20_00);
  assert.throws(() => buildAllocation(
    [{ salaryCents: Number.MAX_SAFE_INTEGER }, { salaryCents: 1 }],
    [],
    [],
  ), (error) => error.code === 'INSIGHTS_STATE_INVALID');
});
