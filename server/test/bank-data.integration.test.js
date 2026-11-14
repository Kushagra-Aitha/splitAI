// B15 · Bank data in Split against live Tiger Data: your category, salary and
// recurring. Opt in with RUN_BANK_DATA_DB_TESTS=1. Fresh throwaway schema.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

test('live database: categories you set, salary and recurring flow into Overview and Transactions', {
  skip: process.env.RUN_BANK_DATA_DB_TESTS !== '1',
}, async (t) => {
  await import('../lib/env.js');
  const schema = `split_b_bankdata_${randomUUID().replaceAll('-', '')}`;
  process.env.DB_SCHEMA = schema;
  const { getPool, closePool } = await import('../db/pool.js');
  const { migrate } = await import('../db/migrate.js');
  const { getOverview, parseRange } = await import('../banking/overview.js');
  const { listTransactions, setTransactionCategory } = await import('../banking/transactions.js');
  const db = getPool();
  let owned = false;
  t.after(async () => {
    try {
      if (owned) await db.query(`DROP SCHEMA "${schema}" CASCADE`);
    } finally {
      await closePool();
    }
  });
  await db.query(`CREATE SCHEMA "${schema}"`);
  owned = true;
  await migrate({ log: () => {} });

  const user = async (handle) => (await db.query(
    `INSERT INTO users (handle, display_name, initials) VALUES ($1, $1, 'X') RETURNING id`, [handle])).rows[0].id;
  const olive = await user('olive');
  const finn = await user('finn');
  const account = async (owner) => (await db.query(
    `INSERT INTO bank_accounts (user_id, provider, provider_account_id, kind, balance_cents, available_cents, linked_at)
     VALUES ($1, 'nessie', $2, 'checking', 100000, 100000, now()) RETURNING id`, [owner, `acct_${randomUUID().slice(0, 8)}`])).rows[0].id;
  const checking = await account(olive);
  const finnChecking = await account(finn);

  const tx = async (accountId, kind, direction, cents, name, occurredAt, category = 'Food & drink') => {
    const id = randomUUID();
    const key = `nessie-${id.slice(0, 12)}`;
    await db.query('INSERT INTO bank_import_keys (account_id, provider_key, transaction_id, occurred_at) VALUES ($1, $2, $3, $4)',
      [accountId, key, id, occurredAt]);
    await db.query(
      `INSERT INTO bank_transactions (id, occurred_at, account_id, provider_transaction_id, kind, direction, amount_cents,
                                      status, description, merchant_name, category, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'completed', $8, $9, $10, 'nessie')`,
      [id, occurredAt, accountId, key, kind, direction, cents, name, kind === 'deposit' ? null : name, category]);
    return { id, key };
  };

  const pizza = await tx(checking, 'purchase', 'debit', 2_400, "Domino's", '2026-11-10T18:00:00Z');
  await tx(checking, 'purchase', 'debit', 1_599, 'Netflix', '2026-10-05T12:00:00Z', 'Just for fun');
  const netflix = await tx(checking, 'purchase', 'debit', 1_599, 'Netflix', '2026-11-05T12:00:00Z', 'Just for fun');
  const rent = await tx(checking, 'purchase', 'debit', 160_000, 'Puffton Village', '2026-11-01T14:00:00Z', 'Home & bills');
  await tx(checking, 'deposit', 'credit', 210_000, 'Payroll · Acme Co', '2026-10-30T13:00:00Z', null);
  await tx(checking, 'deposit', 'credit', 210_000, 'Payroll · Acme Co', '2026-11-13T13:00:00Z', null);
  await tx(checking, 'deposit', 'credit', 5_000, 'Coffee money', '2026-11-12T13:00:00Z', null);
  const finnTx = await tx(finnChecking, 'purchase', 'debit', 900, 'Not yours', '2026-11-11T12:00:00Z');

  // Rent was paid by a Capital Two recurring payment.
  const { rows: [schedule] } = await db.query(
    `INSERT INTO capital_schedules (user_id, account_id, payee, amount_cents, day_of_month, next_due_on, request_key)
     VALUES ($1, $2, 'Puffton Village', 160000, 1, '2026-12-01', $3) RETURNING id`, [olive, checking, randomUUID()]);
  await db.query(
    `INSERT INTO capital_operations (user_id, account_id, kind, payee, amount_cents, request_key, schedule_id, occurrence, status, provider_reference)
     VALUES ($1, $2, 'purchase', 'Puffton Village', 160000, $3, $4, '2026-11', 'completed', $5)`,
    [olive, checking, randomUUID(), schedule.id, rent.key]);

  const range = parseRange({ from: '2026-11-01', to: '2026-11-14' });
  const before = await getOverview(db, checking, range);
  assert.equal(before.breakdown.categories.find((c) => c.category === 'Food & drink').cents, 2_400);

  // Re-categorize the pizza: Overview and Transactions follow; the bank's value stays.
  const changed = await setTransactionCategory(db, olive, pizza.id, { category: 'Getting around' });
  assert.deepEqual(changed.transaction, { id: pizza.id, category: 'Getting around', bankCategory: 'Food & drink', categoryOverridden: true });
  const after = await getOverview(db, checking, range);
  assert.equal(after.breakdown.categories.find((c) => c.category === 'Getting around').cents, 2_400);
  assert.equal(after.breakdown.categories.some((c) => c.category === 'Food & drink'), false);
  const filtered = await listTransactions(db, olive, new URLSearchParams({ category: 'Getting around' }));
  assert.deepEqual(filtered.transactions.map((row) => row.id), [pizza.id]);
  assert.ok(filtered.categoryChoices.includes('Groceries'));
  assert.equal(filtered.transactions[0].bankCategory, 'Food & drink');
  const { rows: [bankRow] } = await db.query('SELECT category FROM bank_transactions WHERE id = $1', [pizza.id]);
  assert.equal(bankRow.category, 'Food & drink');

  // Reset to the bank's category; someone else's transaction is out of reach.
  assert.equal((await setTransactionCategory(db, olive, pizza.id, { category: null })).transaction.category, 'Food & drink');
  await assert.rejects(setTransactionCategory(db, olive, finnTx.id, { category: 'Other' }), { code: 'TRANSACTION_NOT_FOUND' });
  for (const bad of [{ category: '' }, { category: 'x'.repeat(41) }, { category: 42 }, { category: 'ok', extra: 1 }, {}]) {
    await assert.rejects(setTransactionCategory(db, olive, pizza.id, bad), { code: 'INVALID_CATEGORY' });
  }

  // Recurring: scheduled (Capital Two) and detected (same merchant and amount last month).
  const all = await listTransactions(db, olive, new URLSearchParams());
  const byId = new Map(all.transactions.map((row) => [row.id, row]));
  assert.deepEqual([byId.get(rent.id).recurring, byId.get(rent.id).recurringPayee], ['scheduled', 'Puffton Village']);
  assert.equal(byId.get(netflix.id).recurring, 'detected');
  assert.equal(byId.get(pizza.id).recurring, null);

  // Salary: payroll deposits are labeled; the next one follows the last gap (14 days).
  const salaryRows = all.transactions.filter((row) => row.salary);
  assert.equal(salaryRows.length, 2);
  assert.equal(all.transactions.find((row) => row.description === 'Coffee money').salary, false);
  assert.deepEqual(after.salary, { amountCents: 210_000, employer: 'Acme Co', lastPaidOn: '2026-11-13', nextPaidOn: '2026-11-27' });
});
