import assert from 'node:assert/strict';
import test from 'node:test';
import { createGoalStore, normalizeGoals, goalPercent } from '../../src/features/goals/store.js';

const goal = (savedCents) => ({ id: 'goal-1', name: 'Savings', type: 'savings', targetCents: 100, savedCents, targetDate: null });
test('goal progress supports optional dates, exact percentages and over-target savings', () => {
  const [g] = normalizeGoals({ goals: [goal(150)] });
  assert.equal(g.saved, 150);
  assert.equal(g.date, null);
  assert.equal(goalPercent(g), 100);
  assert.equal(goalPercent({ saved: 99, target: 100 }), 99);
  assert.throws(() => normalizeGoals({ goals: [goal(Number.MAX_SAFE_INTEGER + 1)] }));
});

test('an invalidated old goal read cannot overwrite a newer state', async () => {
  const completes = [];
  const store = createGoalStore({ request: () => new Promise((resolve) => { completes.push(resolve); }) });
  const pending = store.load();
  store.invalidate();
  const newer = store.load();
  completes[1]({ goals: [goal(30)] });
  await newer;
  completes[0]({ goals: [goal(10)] });
  await pending;
  assert.equal(store.state.goals[0].saved, 30);
  assert.equal(store.state.status, 'ready');
});

test('a pending save prevents a second submit from posting another movement', async () => {
  let finish;
  let posts = 0;
  const store = createGoalStore({ request: async (path, options) => {
    if (!options) return { goals: [goal(20)] };
    posts++;
    return new Promise((resolve) => { finish = resolve; });
  } });
  const first = store.save('/api/goals', { requestKey: 'one' });
  assert.equal(await store.save('/api/goals', { requestKey: 'two' }), null);
  finish({ goal: goal(20), movement: { id: 'one' } });
  await first;
  assert.equal(posts, 1);
});

test('failed writes preserve confirmed progress; retries recover canonical state and celebrate once', async () => {
  let fail = false;
  let saved = 10;
  let posts = 0;
  const receipt = { goal: goal(20), movement: { id: 'movement-1' } };
  const store = createGoalStore({ request: async (path, options) => {
    if (!options) return { goals: [goal(saved)] };
    posts++;
    if (fail) throw new Error('Insufficient funds');
    saved = 30; // A later write exists: the replay receipt is older.
    return receipt;
  } });
  await store.load();
  fail = true;
  await assert.rejects(store.save('/api/goals/goal-1/movements', { requestKey: 'same-key' }), /Insufficient funds/);
  assert.equal(store.state.goals[0].saved, 10);
  fail = false;
  assert.equal((await store.save('/api/goals/goal-1/movements', { requestKey: 'same-key' })).firstReceipt, true);
  assert.equal(store.state.goals[0].saved, 30);
  assert.equal((await store.save('/api/goals/goal-1/movements', { requestKey: 'same-key' })).firstReceipt, false);
  assert.equal(posts, 3);
});

test('refresh failure after a successful write is reported as saved, without changing the last displayed amount', async () => {
  const store = createGoalStore({ request: async (path, options) => {
    if (!options) throw new Error('Offline');
    return { movement: { id: 'saved' } };
  } });
  store.state.goals = [{ saved: 10 }];
  await assert.rejects(store.save('/api/goals', {}), /Saved on the server/);
  assert.equal(store.state.goals[0].saved, 10);
});

test('history ignores an invalidated response and retains earlier pages on a recoverable failure', async () => {
  let finish;
  const store = createGoalStore({ request: () => new Promise((resolve) => { finish = resolve; }) });
  const pending = store.loadHistory('goal-1');
  store.invalidate(); finish({ items: [], nextCursor: null }); await pending;
  assert.equal(store.state.histories.has('goal-1'), false);
  let fail = false;
  const paged = createGoalStore({ request: async () => {
    if (fail) throw new Error('Temporary read failure');
    return { items: [{ id: 'm1', kind: 'contribution', cents: 40, createdAt: '2026-11-14T17:00:00Z' }], nextCursor: 'next' };
  } });
  await paged.loadHistory('goal-1'); fail = true;
  await paged.loadHistory('goal-1', true);
  assert.equal(paged.state.histories.get('goal-1').items[0].cents, 40);
  assert.equal(paged.state.histories.get('goal-1').status, 'error');
});
