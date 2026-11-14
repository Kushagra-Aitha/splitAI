import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { dateOnly, nextMonthly, operationInput, scheduleInput, today } from '../capital-two/input.js';

test('Capital Two validates exact cents and server-owned identity fields', () => {
  const body = { kind: 'purchase', accountId: randomUUID(), payee: "Domino's", amountCents: 2400, requestKey: randomUUID() };
  assert.equal(operationInput(body).amountCents, 2400);
  for (const extra of [{ amountCents: 1.1 }, { amountCents: 0 }, { amountCents: Number.MAX_SAFE_INTEGER },
    { userId: randomUUID() }, { kind: 'transfer' }, { payee: '\u0000' }, { payee: ' ' }, { requestKey: 'bad' }]) {
    assert.throws(() => operationInput({ ...body, ...extra }), (error) => error.status === 422);
  }
});

test('monthly payment dates clamp short months, preserve leap years and use New York dates', () => {
  assert.equal(nextMonthly('2026-01-31', 31), '2026-02-28');
  assert.equal(nextMonthly('2028-01-31', 31), '2028-02-29');
  assert.equal(nextMonthly('2026-02-28', 31), '2026-03-31');
  assert.equal(nextMonthly('2026-12-31', 31), '2027-01-31');
  assert.equal(nextMonthly('2026-11-14', 14, true), '2026-11-14');
  assert.equal(today(new Date('2026-11-14T02:00:00Z')), '2026-11-13');
  assert.throws(() => dateOnly('2026-02-30'));
  const input = { accountId: randomUUID(), payee: 'Rent', amountCents: 10000, requestKey: randomUUID(), dayOfMonth: 31 };
  assert.equal(scheduleInput(input, '2026-02-01').dueOn, '2026-02-28');
  assert.throws(() => scheduleInput({ ...input, dueOn: '2026-02-02' }, '2026-02-01'));
});
