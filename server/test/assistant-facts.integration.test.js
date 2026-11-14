import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { readFinancialFacts } from '../assistant/facts.js';

test('live database: assistant facts use actor scope and one read-only snapshot', {
  skip: process.env.RUN_FACTS_DB_TESTS !== '1',
}, async (t) => {
  await import('../lib/env.js');
  const schema = `split_c_facts_${randomUUID().replaceAll('-', '')}`;
  process.env.DB_SCHEMA = schema;
  const { getPool, withTransaction, closePool } = await import('../db/pool.js');
  const { migrate } = await import('../db/migrate.js');
  const { seed } = await import('../db/seed.js');
  const { ACCOUNTS, USERS, GROUPS } = await import('../db/demo-ids.js');
  const { createLedgerHandlers } = await import('../ledger/handlers.js');
  const db = getPool();
  let owned = false;
  t.after(async () => {
    try { if (owned) await db.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await closePool(); }
  });
  await db.query(`CREATE SCHEMA "${schema}"`);
  owned = true;
  await migrate({ log: () => {} });
  await seed({ log: () => {} });
  await db.query('UPDATE bank_accounts SET balance_cents = 5000, available_cents = 5000, balance_as_of = now() WHERE id = $1', [ACCOUNTS.maya]);
  const ledger = createLedgerHandlers({ query: (...args) => db.query(...args), withTransaction });
  const { draft } = await ledger['expenseDrafts.create']({ actor: { userId: USERS.sam }, body: {
    groupId: GROUPS.puffton4, merchant: 'Synthetic lunch', cents: 4000, participantIds: [USERS.sam, USERS.maya],
  } });
  await ledger['expenseDrafts.confirm']({ actor: { userId: USERS.sam }, params: { id: draft.id } });
  const now = new Date('2026-11-14T18:00:00Z');
  const query = new URLSearchParams('from=2026-11-14&to=2026-11-14');
  let changed = false;
  const snapshot = await readFinancialFacts({ actorId: USERS.maya, query, now,
    withTransaction: (fn) => withTransaction((tx) => fn({ query: async (sql, args) => {
      const result = await tx.query(sql, args);
      if (!changed && sql.includes('AS "settlementHoldsCents"')) {
        changed = true;
        // A concurrent refresh/activity import must be entirely outside this
        // already established snapshot, even though overview reads happen next.
        await db.query('UPDATE bank_accounts SET balance_cents = 100, available_cents = 100 WHERE id = $1', [ACCOUNTS.maya]);
        await db.query(`INSERT INTO bank_transactions
          (account_id, provider_transaction_id, kind, direction, amount_cents, status, occurred_at, source)
          VALUES ($1, $2, 'purchase', 'debit', 1234, 'completed', $3, 'demo')`, [ACCOUNTS.maya, randomUUID(), now]);
      }
      return result;
    } })),
  });
  assert.ok(changed);
  assert.equal(snapshot.funds.spendableCents, 5000);
  assert.equal(snapshot.spending.totals.spentCents, 0);
  assert.equal(snapshot.debts.find((debt) => debt.groupId === GROUPS.puffton4).cents, 2000);
  assert.equal(snapshot.groups.length, 2);
  assert.deepEqual(snapshot.spending.range, { from: '2026-11-14', to: '2026-11-14', bucket: 'day', timeZone: 'America/New_York' });
  const refreshed = await readFinancialFacts({ withTransaction, actorId: USERS.maya, query, now });
  assert.equal(refreshed.funds.spendableCents, 100);
  assert.equal(refreshed.spending.totals.spentCents, 1234);
  const alex = await readFinancialFacts({ withTransaction, actorId: USERS.alex, query, now });
  assert.equal(alex.groups.length, 1);
  assert.equal(alex.spending.totals.spentCents, 0);
  assert.equal(alex.debts.length, 0);
});
