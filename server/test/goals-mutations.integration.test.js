import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import test from 'node:test';
import { loginAs, memoryAuth } from './support/auth.js';
import { createGoalHandlers } from '../goals/handlers.js';
import { lockAccount, reserveFunds, getSpendableFunds } from '../banking/funds.js';
import { readFinancialFacts } from '../assistant/facts.js';
import { affordabilityPlan } from '../assistant/answers.js';
import { createLedgerHandlers } from '../ledger/handlers.js';
import { createApp } from '../app.js';
import { loadConfig } from '../config.js';

test('live database: atomic repeat-safe goal lifecycle uses the shared funds lock', {
  skip: process.env.RUN_GOALS_DB_TESTS !== '1',
}, async (t) => {
  await import('../lib/env.js');
  const schema = `split_c_goal_writes_${randomUUID().replaceAll('-', '')}`;
  process.env.DB_SCHEMA = schema;
  const { getPool, withTransaction, closePool } = await import('../db/pool.js');
  const { migrate } = await import('../db/migrate.js');
  const { seed } = await import('../db/seed.js');
  const { USERS, ACCOUNTS, GROUPS } = await import('../db/demo-ids.js');
  const db = getPool();
  let owned = false;
  t.after(async () => {
    try { if (owned) await db.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await closePool(); }
  });
  await db.query(`CREATE SCHEMA "${schema}"`);
  owned = true;
  await migrate({ log: () => {} });
  await seed({ log: () => {} });
  const query = (...args) => db.query(...args);
  const api = createGoalHandlers({ query, withTransaction });
  const actor = { userId: USERS.maya };
  const create = (body) => api['goals.create']({ actor, body });
  const move = (id, body, selectedActor = actor) => api['goals.move']({ actor: selectedActor, params: { id }, body });
  const body = (initialCents = 0) => ({ name: 'Synthetic savings', type: 'savings', targetCents: 1000, initialCents, requestKey: randomUUID() });
  const movement = (kind, cents) => ({ kind, cents, requestKey: randomUUID() });
  const resetBalance = (cents) => db.query('UPDATE bank_accounts SET balance_cents = $2, available_cents = $2, balance_as_of = now() WHERE id = $1', [ACCOUNTS.maya, cents]);
  const counts = async () => (await db.query(`SELECT (SELECT count(*)::int FROM goals) AS goals,
    (SELECT count(*)::int FROM goal_movements) AS movements,
    (SELECT count(*)::int FROM goal_creation_requests) AS requests`)).rows[0];
  await resetBalance(20000);
  let goalId;

  await t.test('creation and initial contribution commit once under concurrent retries', async () => {
    const input = body(1500); // Above the target is allowed.
    const [a, b] = await Promise.all([create(input), create(input)]);
    assert.deepEqual(a, b);
    goalId = a.goal.id;
    assert.equal(a.goal.savedCents, 1500);
    assert.equal(a.goal.targetDate, null);
    assert.equal(a.funds.spendableCents, 18500);
    assert.deepEqual(await counts(), { goals: 1, movements: 1, requests: 1 });
    await assert.rejects(create({ ...input, name: 'Different' }), (e) => e.code === 'REQUEST_KEY_REUSED');
    await move(goalId, movement('contribution', 100));
    assert.deepEqual(await create(input), a, 'replay keeps the original receipt after later movements');
  });

  await t.test('movements are repeat-safe, conflicting keys fail, withdrawals release exact funds', async () => {
    const input = movement('contribution', 400);
    const [a, b] = await Promise.all([move(goalId, input), move(goalId, input)]);
    assert.deepEqual(a, b);
    assert.equal(a.goal.savedCents, 2000);
    assert.equal(a.funds.spendableCents, 18000);
    await assert.rejects(move(goalId, { ...input, cents: 500 }), (e) => e.code === 'REQUEST_KEY_REUSED');
    await assert.rejects(move(goalId, { ...input, kind: 'withdrawal' }), (e) => e.code === 'REQUEST_KEY_REUSED');
    const withdrawal = await move(goalId, movement('withdrawal', 1200));
    assert.equal(withdrawal.goal.savedCents, 800);
    assert.equal(withdrawal.funds.spendableCents, 19200);
    assert.deepEqual(await move(goalId, input), a);
    const before = await counts();
    await assert.rejects(move(goalId, movement('withdrawal', 801)), (e) => e.code === 'INSUFFICIENT_SAVINGS');
    assert.deepEqual(await counts(), before);
  });

  await t.test('insufficient initial funding creates neither goal, movement nor retry record', async () => {
    const before = await counts();
    await assert.rejects(create(body(19201)), (e) => e.code === 'INSUFFICIENT_FUNDS');
    assert.deepEqual(await counts(), before);
    const a = body(100);
    const failing = createGoalHandlers({ query, withTransaction: (fn) => withTransaction((tx) => fn({ query: (sql, ...args) => {
      if (sql.includes('INSERT INTO goal_creation_requests')) throw new Error('Synthetic receipt failure');
      return tx.query(sql, ...args);
    } })) });
    await assert.rejects(failing['goals.create']({ actor, body: a }), /Synthetic receipt failure/);
    assert.deepEqual(await counts(), before);
    assert.equal((await getSpendableFunds(ACCOUNTS.maya)).spendableCents, 19200);
  });

  await t.test('cross-actor writes and unknown balances fail closed without partial writes', async () => {
    await assert.rejects(move(goalId, movement('contribution', 100), { userId: USERS.sam }), (e) => e.status === 403);
    const before = await counts();
    await db.query('UPDATE bank_accounts SET balance_cents = NULL, available_cents = NULL WHERE id = $1', [ACCOUNTS.maya]);
    await assert.rejects(move(goalId, movement('contribution', 100)), (e) => e.code === 'BALANCE_UNKNOWN');
    assert.deepEqual(await counts(), before);
    const withdrawal = await move(goalId, movement('withdrawal', 800));
    assert.equal(withdrawal.goal.savedCents, 0);
    assert.equal(withdrawal.funds.spendableCents, null);
    await resetBalance(5000);
  });

  await t.test('concurrent contributions cannot oversubscribe one account', async () => {
    const other = await create(body());
    const results = await Promise.allSettled([move(goalId, movement('contribution', 4000)), move(other.goal.id, movement('contribution', 3000))]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(results.find((r) => r.status === 'rejected').reason.code, 'INSUFFICIENT_FUNDS');
    const snapshot = await api['goals.list']({ actor });
    const holds = snapshot.goals.reduce((sum, goal) => sum + goal.savedCents, 0);
    assert.equal((await getSpendableFunds(ACCOUNTS.maya)).spendableCents, 5000 - holds);
    for (const goal of snapshot.goals) if (goal.savedCents) await move(goal.id, movement('withdrawal', goal.savedCents));
  });

  await t.test('a goal and settlement reservation serialize on B4, with no oversubscription', async () => {
    const claim = () => withTransaction(async (tx) => {
      await reserveFunds(tx, ACCOUNTS.maya, 3000);
      return tx.query(`INSERT INTO settlements
        (group_id, created_by, payer_user_id, payee_user_id, payer_account_id, payee_account_id, amount_cents, hold_cents, status, review_expires_at)
        VALUES ($1, $2, $2, $3, $4, $5, 3000, 3000, 'pending', now() + interval '15 minutes')`,
      [GROUPS.puffton4, USERS.maya, USERS.sam, ACCOUNTS.maya, ACCOUNTS.sam]);
    });
    const results = await Promise.allSettled([move(goalId, movement('contribution', 4000)), claim()]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(results.find((r) => r.status === 'rejected').reason.code, 'INSUFFICIENT_FUNDS');
    const f = await getSpendableFunds(ACCOUNTS.maya);
    assert.equal(f.spendableCents, 5000 - f.goalHoldsCents - f.settlementHoldsCents);
    // This exercises the real goal operation and B4 reservation. A7 is not
    // available yet: it is deliberately NOT claimed as the full SEC4 test.
    await withTransaction(async (tx) => { await lockAccount(tx, ACCOUNTS.maya); await tx.query('UPDATE settlements SET hold_cents = 0, status = \'failed\''); });
    const snapshot = await api['goals.list']({ actor });
    for (const goal of snapshot.goals) if (goal.savedCents) await move(goal.id, movement('withdrawal', goal.savedCents));
  });

  await t.test('goal contribution and withdrawal change C4 affordability, not the provider balance', async () => {
    const ledger = createLedgerHandlers({ query, withTransaction });
    const { draft } = await ledger['expenseDrafts.create']({ actor: { userId: USERS.sam }, body: {
      groupId: GROUPS.puffton4, merchant: 'Synthetic', cents: 6000, participantIds: [USERS.maya, USERS.sam],
    } });
    await ledger['expenseDrafts.confirm']({ actor: { userId: USERS.sam }, params: { id: draft.id } });
    const plan = async () => affordabilityPlan(await readFinancialFacts({ withTransaction, actorId: USERS.maya }));
    assert.equal((await plan()).coverage, 'all');
    await move(goalId, movement('contribution', 4000));
    assert.equal((await plan()).coverage, 'none');
    await move(goalId, movement('withdrawal', 4000));
    assert.equal((await plan()).coverage, 'all');
    assert.equal((await getSpendableFunds(ACCOUNTS.maya)).balanceCents, 5000);
  });

  await t.test('HTTP goals use the real session/CSRF boundary and return durable retry receipts', async (t) => {
    const origin = 'http://localhost:3001';
    const authStore = await memoryAuth([{ userId: USERS.maya, email: 'maya@split.test', displayName: 'Maya Chen' }]);
    const server = createApp({ handlers: api, authStore, config: loadConfig({ NODE_ENV: 'test', APP_ORIGIN: origin }) });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(async () => { const closed = once(server, 'close'); server.close(); server.closeAllConnections(); await closed; });
    const base = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await fetch(`${base}/api/goals`)).status, 401);
    const login = await loginAs(base, origin, 'maya@split.test');
    assert.equal(login.status, 200);
    const { session, cookie } = login;
    const post = (path, data, csrf = session.csrfToken) => fetch(base + path, { method: 'POST',
      headers: { Origin: origin, Cookie: cookie, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    const input = body(100);
    const before = await counts();
    assert.equal((await post('/api/goals', input, 'forged')).status, 403);
    assert.deepEqual(await counts(), before);
    const first = await post('/api/goals', input);
    assert.equal(first.status, 200);
    const receipt = await first.json();
    assert.equal(receipt.goal.savedCents, 100);
    assert.deepEqual(await (await post('/api/goals', input)).json(), receipt);
    const result = await post(`/api/goals/${receipt.goal.id}/movements`, movement('withdrawal', 100));
    assert.equal(result.status, 200);
    assert.equal((await result.json()).goal.savedCents, 0);
  });

  await t.test('inconsistent durable reservations block writes without repairing or hiding them', async () => {
    await db.query('UPDATE goals SET saved_cents = 1 WHERE id = $1', [goalId]);
    const before = await counts();
    await assert.rejects(move(goalId, movement('contribution', 100)), (e) => e.code === 'GOAL_STATE_INVALID');
    await assert.rejects(create(body()), (e) => e.code === 'GOAL_STATE_INVALID');
    assert.deepEqual(await counts(), before);
  });
});
