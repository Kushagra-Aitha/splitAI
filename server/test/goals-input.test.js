import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { creationInput, movementInput } from '../goals/handlers.js';

const base = () => ({ name: 'Emergency savings', type: 'savings', targetCents: 10000, requestKey: randomUUID() });
test('goal inputs allow optional dates and over-target initial savings with exact bounded cents', () => {
  assert.equal(creationInput(base()).targetDate, null);
  assert.equal(creationInput({ ...base(), initialCents: 15000 }).initialCents, 15000);
  assert.equal(creationInput({ ...base(), targetDate: '2028-02-29' }).targetDate, '2028-02-29');
  for (const targetDate of ['2026-02-29', '2026-02-30', '0000-01-01', '2026-1-1', '<script>']) {
    assert.throws(() => creationInput({ ...base(), targetDate }), (e) => e.status === 422);
  }
  for (const patch of [{ initialCents: -1 }, { targetCents: 0 }, { type: 'other' }, { name: '\u202eGoal' },
    { accountId: randomUUID() }, { requestKey: '' }, { targetCents: Number.MAX_SAFE_INTEGER + 1 }]) {
    assert.throws(() => creationInput({ ...base(), ...patch }), (e) => e.status === 422);
  }
});
test('goal movements require an explicit kind, retry key and positive integer cents', () => {
  const body = { kind: 'withdrawal', cents: 1, requestKey: randomUUID() };
  assert.deepEqual(movementInput(body), body);
  for (const patch of [{ kind: 'transfer' }, { cents: 0 }, { cents: 0.5 }, { cents: '100' }, { requestKey: null }, { userId: randomUUID() }]) {
    assert.throws(() => movementInput({ ...body, ...patch }), (e) => e.status === 422);
  }
});
