import assert from 'node:assert/strict';
import test from 'node:test';
import { progressForGoal } from '../assistant/goal-progress.js';
import { validateIntent } from '../assistant/intent.js';
test('goal projections use saved cents, optional dates and explicit observed net pace', () => {
  const goal = { id: 'g', name: 'Trip', targetCents: 10000, savedCents: 4000, createdAt: '2026-11-01T17:00:00Z', targetDate: '2026-12-01' };
  const now = new Date('2026-11-11T17:00:00Z');
  const result = progressForGoal(goal, now);
  assert.equal(result.status, 'on_track'); assert.equal(result.paceCentsPerDay, 400); assert.equal(result.requiredCentsPerDay, 300);
  assert.equal(progressForGoal({ ...goal, savedCents: 100 }, now).status, 'short');
  assert.equal(progressForGoal({ ...goal, savedCents: 12000 }, now).status, 'funded');
  assert.equal(progressForGoal({ ...goal, targetDate: null }, now).status, 'no_date');
  assert.equal(progressForGoal({ ...goal, targetDate: '2026-11-10' }, now).status, 'short');
  assert.equal(progressForGoal({ ...goal, createdAt: now }, now).paceCentsPerDay, 4000);
});
test('reminder parsing accepts hints only, never a model-supplied amount', () => {
  const expense = { merchant: 'Pizza', groupHint: null, participantNames: ['Sam'], cents: null };
  assert.equal(validateIntent({ intent: 'reminder', expense }).intent, 'reminder');
  assert.throws(() => validateIntent({ intent: 'reminder', expense: { ...expense, cents: 1000 } }));
  assert.equal(validateIntent({ intent: 'goal_progress', expense: null }).intent, 'goal_progress');
});
