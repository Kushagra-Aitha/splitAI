import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { dateOnly, nextMonthly, nextSalary, operationInput, salaryPeriod, scheduleInput, today } from '../capital-two/input.js';

test('Capital Two validates exact cents and server-owned identity fields', () => {
  const body = { kind: 'purchase', category: 'Food & drink', accountId: randomUUID(), payee: "Domino's", amountCents: 2400, requestKey: randomUUID() };
  assert.equal(operationInput(body).amountCents, 2400);
  for (const extra of [{ amountCents: 1.1 }, { amountCents: 0 }, { amountCents: Number.MAX_SAFE_INTEGER },
    { userId: randomUUID() }, { kind: 'transfer' }, { kind: 'deposit' }, { category: undefined }, { category: 'Invalid' }, { payee: '\u0000' }, { payee: ' ' }, { requestKey: 'bad' }]) {
    assert.throws(() => operationInput({ ...body, ...extra }), (error) => error.status === 422);
  }
});

test('salary periods retain their anchor across short months, leap years and missed runs', () => {
  const monthly = { firstDueOn: '2028-01-31', dayOfMonth: 31, frequency: 'monthly' };
  assert.equal(salaryPeriod(monthly, '2028-02-15'), '2028-02-29');
  assert.equal(nextSalary(monthly, '2028-02-29', '2028-02-15'), '2028-03-31');
  assert.equal(salaryPeriod(monthly, '2027-12-15'), '2028-01-31');
  const biweekly = { firstDueOn: '2026-12-25', frequency: 'biweekly' };
  assert.equal(salaryPeriod(biweekly, '2027-01-07'), '2026-12-25');
  assert.equal(salaryPeriod(biweekly, '2027-01-08'), '2027-01-08');
  assert.equal(nextSalary(biweekly, '2026-12-25', '2027-02-01'), '2027-02-05');
  const body = { kind: 'salary', frequency: 'biweekly', dueOn: '2026-12-25', accountId: randomUUID(), payee: 'Employer', amountCents: 50000, requestKey: randomUUID() };
  assert.equal(scheduleInput(body, '2026-11-14').category, 'Salary');
  assert.throws(() => scheduleInput({ ...body, frequency: 'daily' }));
  assert.throws(() => scheduleInput({ ...body, dayOfMonth: 25 }));
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
