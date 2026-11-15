import assert from 'node:assert/strict';
import test from 'node:test';
import { cardAmountDue, nextStatementDueDate } from '../banking/card-due.js';

test('statement dates use the next due day and clamp short months', () => {
  assert.equal(nextStatementDueDate(25, '2026-11-14'), '2026-11-25');
  assert.equal(nextStatementDueDate(25, '2026-11-25'), '2026-11-25');
  assert.equal(nextStatementDueDate(25, '2026-11-26'), '2026-12-25');
  assert.equal(nextStatementDueDate(31, '2027-02-01'), '2027-02-28');
  assert.equal(nextStatementDueDate(null, '2026-11-14'), null);
});

test('card amount due matches limit minus available credit', () => {
  assert.equal(cardAmountDue({ creditLimitCents: 200000, availableCents: 150000 }), 50000);
  assert.equal(cardAmountDue({ creditLimitCents: 200000, availableCents: 220000 }), 0);
  assert.equal(cardAmountDue({ creditLimitCents: null, availableCents: null }), null);
});
