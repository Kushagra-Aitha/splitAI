import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import test from 'node:test';
import { createApp } from '../app.js';
import { loadConfig } from '../config.js';
import { lockAccount, reserveFunds } from '../banking/funds.js';
import { recordGuardEvent } from '../guard/events.js';
import { createLedgerHandlers } from '../ledger/handlers.js';
import { createSettlementConfirmation } from '../ledger/confirm-settlement.js';
import { reconcileSettlements } from '../ledger/reconcile-settlements.js';
import { NessieError } from '../lib/nessie.js';
import { createNotificationHandlers } from '../notifications/handlers.js';
import { notify } from '../notifications/notify.js';
import { loginAs, memoryAuth } from './support/auth.js';

test('live database: private, atomic and repeat-safe notifications with real session boundaries', {
  skip: process.env.RUN_NOTIFICATIONS_DB_TESTS !== '1',
}, async (t) => {
  const schema = `split_c_notify_${randomUUID().replaceAll('-', '')}`;
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
  await db.query(`CREATE SCHEMA "${schema}"`); owned = true;
  await migrate({ log: () => {} });
  await seed({ log: () => {} });
  const query = (...args) => db.query(...args);
  const ledger = createLedgerHandlers({ query, withTransaction });
  const notifications = createNotificationHandlers({ query });
  const actor = (name) => ({ userId: USERS[name] });
  const list = (name, params = '') => notifications['notifications.list']({ actor: actor(name), query: new URLSearchParams(params) });
  const sourceRows = async (id) => (await db.query(`SELECT recipient_user_id AS recipient, kind, read_at
    FROM notifications WHERE source_id = $1 ORDER BY kind, recipient_user_id`, [id])).rows;
  const draft = async (handler = ledger, cents = 4200) => (await handler['expenseDrafts.create']({
    actor: actor('sam'), body: { groupId: GROUPS.puffton4, merchant: 'Synthetic Dinner', cents,
      participantIds: [USERS.sam, USERS.maya] },
  })).draft;
  const confirm = (handler, expense) => handler['expenseDrafts.confirm']({ actor: actor('sam'), params: { id: expense.id } });

  const origin = 'http://localhost:3001';
  const authStore = await memoryAuth(Object.entries(USERS).map(([name, userId]) => ({
    userId, email: `${name}@split.test`, displayName: name,
  })));
  const server = createApp({ config: loadConfig({ NODE_ENV: 'test', APP_ORIGIN: origin }), authStore, handlers: notifications });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { const closed = once(server, 'close'); server.close(); server.closeAllConnections(); await closed; });
  const base = `http://127.0.0.1:${server.address().port}`;
  const maya = await loginAs(base, origin, 'maya@split.test');
  const sam = await loginAs(base, origin, 'sam@split.test');
  assert.equal(maya.status, 200); assert.equal(sam.status, 200);
  const read = (login, ids, extra = {}, csrf = login.session.csrfToken) => fetch(`${base}/api/notifications/read`, {
    method: 'POST', headers: { Origin: origin, Cookie: login.cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
    body: JSON.stringify({ ids, ...extra }),
  });

  await t.test('only the included non-creator gets one alert, even for a zero-cent share and confirmation retries', async () => {
    const expense = await draft(ledger, 1);
    assert.equal((await sourceRows(expense.id)).length, 0);
    await confirm(ledger, expense); await confirm(ledger, expense);
    assert.deepEqual((await sourceRows(expense.id)).map(({ recipient, kind }) => ({ recipient, kind })), [
      { recipient: USERS.maya, kind: 'expense_added' },
    ]);
    const response = await fetch(`${base}/api/notifications?userId=${USERS.sam}`, { headers: { Cookie: maya.cookie } });
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    const page = await response.json();
    assert.equal(page.unreadCount, 1); assert.equal(page.items[0].sourceId, expense.id);
    assert.equal((await read(sam, [page.items[0].id, randomUUID()])).status, 200);
    assert.equal((await list('maya')).unreadCount, 1);
    assert.equal((await read(maya, [page.items[0].id], {}, 'forged')).status, 403);
    assert.equal((await read(maya, [page.items[0].id], { userId: USERS.sam })).status, 422);
    assert.equal((await fetch(`${base}/api/notifications`)).status, 401);
    assert.equal((await read(maya, [page.items[0].id])).status, 200);
    const firstRead = (await sourceRows(expense.id))[0].read_at;
    await read(maya, [page.items[0].id]);
    assert.deepEqual((await sourceRows(expense.id))[0].read_at, firstRead);
    assert.equal((await list('maya')).unreadCount, 0);
    assert.equal((await list('sam')).items.length, 0);
  });

  await t.test('notification storage failure rolls back the expense, audit and notification together', async () => {
    const expense = await draft();
    const failing = createLedgerHandlers({ query, withTransaction: (fn) => withTransaction((tx) => fn({
      query: async (...args) => {
        const result = await tx.query(...args);
        if (args[0].includes('INSERT INTO notifications')) throw new Error('Synthetic persistence failure');
        return result;
      },
    })) });
    await assert.rejects(confirm(failing, expense), /Synthetic persistence failure/);
    assert.equal((await db.query('SELECT status FROM expenses WHERE id = $1', [expense.id])).rows[0].status, 'draft');
    assert.equal((await db.query('SELECT id FROM guard_events WHERE expense_id = $1', [expense.id])).rowCount, 0);
    assert.equal((await sourceRows(expense.id)).length, 0);
  });

  await t.test('Guard blocks notify only the actor, with no copied private context and atomic rollback', async () => {
    const id = await withTransaction((tx) => recordGuardEvent(tx, { actorUserId: USERS.sam,
      groupId: GROUPS.puffton4, reasonCode: 'UNTRUSTED_CONTEXT' }));
    await withTransaction((tx) => notify(tx, { kind: 'guard_blocked', sourceId: id }));
    assert.deepEqual((await sourceRows(id)).map(({ recipient, kind }) => ({ recipient, kind })), [
      { recipient: USERS.sam, kind: 'guard_blocked' },
    ]);
    const item = (await list('sam')).items.find((entry) => entry.sourceId === id);
    assert.equal(item.groupId, null); assert.equal(item.expenseId, null);
    assert.deepEqual(Object.keys(item).sort(), ['actorName', 'actorUserId', 'createdAt', 'expenseId', 'groupId', 'groupName',
      'id', 'isPayer', 'kind', 'merchant', 'payeeName', 'readAt', 'settlementCents', 'sourceId', 'totalCents', 'yourShareCents']);
    const before = (await list('sam')).unreadCount;
    await assert.rejects(withTransaction(async (tx) => {
      await recordGuardEvent(tx, { actorUserId: USERS.sam, reasonCode: 'UNTRUSTED_CONTEXT' });
      throw new Error('rollback');
    }), /rollback/);
    assert.equal((await list('sam')).unreadCount, before);
  });

  await t.test('sent waits for acknowledgement; reconciliation publishes posted/failed once to both parties', async () => {
    await db.query(`UPDATE bank_accounts SET provider_account_id = 'synthetic-' || id,
      balance_cents = 100000, available_cents = 100000, balance_as_of = now(), linked_at = now()`);
    async function review() {
      await confirm(ledger, await draft(ledger, 600));
      return (await ledger['settlementReviews.create']({ actor: actor('maya'), body: {
        groupId: GROUPS.puffton4, payeeUserId: USERS.sam,
      } })).review;
    }
    for (const terminal of ['completed', 'declined']) {
      const reviewRow = await review();
      const entered = Promise.withResolvers(), accepted = Promise.withResolvers();
      let calls = 0;
      const confirmation = createSettlementConfirmation({ withTransaction, lockAccount, reserveFunds,
        transfer: async () => { calls++; entered.resolve(); return accepted.promise; } });
      const params = { actor: actor('maya'), params: { id: reviewRow.id } };
      const operation = confirmation(params); operation.catch(entered.reject);
      await entered.promise;
      try {
        assert.equal((await sourceRows(reviewRow.id)).length, 0);
        await confirmation(params); assert.equal(calls, 1);
      } finally { accepted.resolve({ data: { id: `synthetic-${reviewRow.id}`, status: 'pending' } }); }
      await operation;
      assert.equal((await sourceRows(reviewRow.id)).length, 2);
      const activity = { balance: { availableCents: 100000 }, transactions: [{ kind: 'transfer', direction: 'debit',
        amountCents: reviewRow.amountCents, counterpartyAccountId: `synthetic-${ACCOUNTS.sam}`,
        providerTransactionId: `synthetic-${reviewRow.id}`, status: terminal }] };
      for (let i = 0; i < 2; i++) await withTransaction(async (tx) => {
        await lockAccount(tx, ACCOUNTS.maya); await reconcileSettlements(tx, ACCOUNTS.maya, activity);
      });
      assert.deepEqual((await sourceRows(reviewRow.id)).map(({ kind }) => kind).sort(), [
        'settlement_sent', 'settlement_sent', terminal === 'completed' ? 'settlement_posted' : 'settlement_failed',
        terminal === 'completed' ? 'settlement_posted' : 'settlement_failed',
      ].sort());
      assert.deepEqual([...new Set((await sourceRows(reviewRow.id)).map(({ recipient }) => recipient))].sort(), [USERS.maya, USERS.sam]);
    }
    const rejected = await review();
    const confirmation = createSettlementConfirmation({ withTransaction, lockAccount, reserveFunds,
      transfer: async () => { throw new NessieError(422, { title: 'Synthetic rejection' }, '/transfers'); } });
    await confirmation({ actor: actor('maya'), params: { id: rejected.id } });
    assert.deepEqual((await sourceRows(rejected.id)).map(({ kind }) => kind), ['settlement_failed', 'settlement_failed']);
  });

  await t.test('current membership gates pages, counts and read updates after soft leave', async () => {
    const group = (await ledger['groups.create']({ actor: actor('sam'), body: { name: 'Private synthetic', kind: 'trip' } })).group;
    await ledger['groups.addMember']({ actor: actor('sam'), params: { id: group.id }, body: { email: 'maya@split.test' } });
    const expense = (await ledger['expenseDrafts.create']({ actor: actor('sam'), body: { groupId: group.id,
      merchant: 'Synthetic', cents: 1, participantIds: [USERS.sam, USERS.maya] } })).draft;
    await confirm(ledger, expense);
    const item = (await list('maya')).items.find((entry) => entry.sourceId === expense.id);
    assert.ok(item);
    // No debt for Maya's zero-cent share: A10 can perform the real soft leave.
    await ledger['groups.leave']({ actor: actor('maya'), params: { id: group.id }, body: {} });
    assert.ok(!(await list('maya')).items.some((entry) => entry.id === item.id));
    await read(maya, [item.id]);
    assert.equal((await sourceRows(expense.id))[0].read_at, null);
    assert.ok(!(await list('alex')).items.some((entry) => entry.id === item.id));
  });

  await t.test('bounded keyset pages preserve microseconds and include each visible row exactly once', async () => {
    const expected = (await db.query(`SELECT n.id FROM notifications n WHERE n.recipient_user_id = $1
      AND (n.group_id IS NULL OR EXISTS (SELECT 1 FROM group_members m WHERE m.group_id = n.group_id
        AND m.user_id = $1 AND m.left_at IS NULL))`, [USERS.maya])).rows.map(({ id }) => id).sort();
    await db.query(`UPDATE notifications SET created_at = '2026-01-01T00:00:00.000001Z'::timestamptz
      + (row_number * interval '1 microsecond') FROM
      (SELECT id AS nid, row_number() OVER (ORDER BY id) AS row_number FROM notifications) x WHERE id = x.nid`);
    let cursor = '', actual = [];
    do {
      const page = await list('maya', `limit=2${cursor ? `&before=${cursor}` : ''}`);
      assert.ok(page.items.length <= 2);
      actual.push(...page.items.map(({ id }) => id)); cursor = page.nextCursor;
    } while (cursor);
    assert.deepEqual(actual.sort(), expected);
    for (const params of ['limit=0', 'limit=51', 'before=invalid']) await assert.rejects(list('maya', params), (error) => error.status === 422);
  });
  await t.test('readable metadata is canonical; mark all read is actor-scoped and hides former-group rows', async () => {
    const expense = await draft(); await confirm(ledger, expense);
    const item = (await list('maya')).items.find((entry) => entry.sourceId === expense.id);
    assert.equal(item.actorUserId, USERS.sam); assert.equal(item.actorName, 'Sam');
    assert.equal(item.merchant, 'Synthetic Dinner'); assert.equal(item.totalCents, 4200); assert.equal(item.yourShareCents, 2100);
    const samBefore = (await list('sam')).unreadCount;
    const response = await fetch(`${base}/api/notifications/read`, { method: 'POST', headers: { Origin: origin,
      Cookie: maya.cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': maya.session.csrfToken }, body: JSON.stringify({ all: true }) });
    assert.equal(response.status, 200);
    assert.equal((await list('maya')).unreadCount, 0);
    assert.equal((await list('sam')).unreadCount, samBefore);
    assert.equal((await db.query(`SELECT id FROM notifications n WHERE recipient_user_id = $1 AND read_at IS NULL
      AND EXISTS (SELECT 1 FROM group_members m WHERE m.group_id = n.group_id AND m.user_id = $1 AND m.left_at IS NOT NULL)`, [USERS.maya])).rowCount, 1);
    await assert.rejects(notifications['notifications.read']({ actor: actor('maya'), body: { all: true, userId: USERS.sam } }), (error) => error.status === 422);
  });
});
