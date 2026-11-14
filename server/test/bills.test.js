import assert from 'node:assert/strict';
import test from 'node:test';
import { nextOccurrence } from '../banking/bills.js';

test('a monthly bill already due today stays today', () => {
  assert.equal(nextOccurrence({ nextDueOn: '2026-11-14', recurrence: 'monthly', dayOfMonth: 14 }, '2026-11-14'), '2026-11-14');
});

test('a past monthly bill rolls to its next day of month', () => {
  assert.equal(nextOccurrence({ nextDueOn: '2026-11-14', recurrence: 'monthly', dayOfMonth: 14 }, '2026-11-20'), '2026-12-14');
  assert.equal(nextOccurrence({ nextDueOn: '2026-10-02', recurrence: 'monthly', dayOfMonth: 2 }, '2027-01-15'), '2027-02-02');
});

test('day 31 clamps to short months and comes back', () => {
  assert.equal(nextOccurrence({ nextDueOn: '2027-01-31', recurrence: 'monthly', dayOfMonth: 31 }, '2027-02-01'), '2027-02-28');
  assert.equal(nextOccurrence({ nextDueOn: '2027-01-31', recurrence: 'monthly', dayOfMonth: 31 }, '2027-03-01'), '2027-03-31');
});

test('weekly and yearly recurrences', () => {
  assert.equal(nextOccurrence({ nextDueOn: '2026-11-02', recurrence: 'weekly' }, '2026-11-14'), '2026-11-16');
  assert.equal(nextOccurrence({ nextDueOn: '2025-11-28', recurrence: 'yearly', dayOfMonth: 28 }, '2026-11-14'), '2026-11-28');
});
