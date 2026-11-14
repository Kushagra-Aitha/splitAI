import assert from 'node:assert/strict';
import test from 'node:test';
import { goalFromRow, readCents } from '../goals/read.js';

test('goal cents preserve exact safe integers and reject overflow before serialization', () => {
  assert.equal(readCents('0'), 0);
  assert.equal(readCents('9007199254740991'), Number.MAX_SAFE_INTEGER);
  for (const value of ['9007199254740992', '9007199254740993', '-1', '1.5', '1e3', '', null, 100]) {
    assert.throws(() => readCents(value), (error) => error.status === 409 && error.code === 'GOAL_STATE_INVALID');
  }
});

test('the public goal balance must match its durable movements and cached reservation', () => {
  const row = { id: 'goal', accountId: 'account', name: 'Savings', type: 'savings',
    targetCents: '10000', cachedSavedCents: '3000', movementSavedCents: '3000',
    targetDate: null, createdAt: '2026-11-14T00:00:00Z', updatedAt: '2026-11-14T00:00:00Z' };
  const goal = goalFromRow(row);
  assert.equal(goal.savedCents, 3000);
  assert.equal(goal.targetCents, 10000);
  assert.equal(goal.cachedSavedCents, undefined);
  assert.throws(() => goalFromRow({ ...row, cachedSavedCents: '4000' }), (error) => error.code === 'GOAL_STATE_INVALID');
  assert.throws(() => goalFromRow({ ...row, movementSavedCents: '-1' }), (error) => error.code === 'GOAL_STATE_INVALID');
});
