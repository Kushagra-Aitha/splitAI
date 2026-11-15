// B17 · Settlements in the bank against live Tiger Data: a settlement takes
// the category of the expenses it pays off, counts as spending for the payer
// and reduces spending for the payee. Opt in with RUN_SETTLED_DB_TESTS=1.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

test('live database: settlements show in the bank in the category they paid for', {
  skip: process.env.RUN_SETTLED_DB_TESTS !== '1',
}, async (t) => {
  await import('../lib/env.js');
  const schema = `split_b_settled_${randomUUID().replaceAll('-', '')}`;
  process.env.DB_SCHEMA = schema;
  const { getPool, closePool, withTransaction } = await import('../db/pool.js');
  const { migrate } = await import('../db/migrate.js');
  const { getOverview, parseRange } = await import('../banking/overview.js');
  const { listTransactions, setTransactionCategory } = await import('../banking/transactions.js');
  const { allocateSettlement, allocateMissingSettlements } = await import('../ledger/settlement-categories.js');
  const { createInsightsHandler } = await import('../insights/read.js');
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

  const user = async (name) => (await db.query(
    `INSERT INTO users (handle, display_name, initials) VALUES ($1, $2, 'X') RETURNING id`, [name.toLowerCase(), name])).rows[0].id;
  const ava = await user('Ava');
  const ben = await user('Ben');
  const account = async (owner) => (await db.query(
    `INSERT INTO bank_accounts (user_id, provider, provider_account_id, kind, balance_cents, available_cents, linked_at)
     VALUES ($1, 'nessie', $2, 'checking', 100000, 100000, now()) RETURNING id`, [owner, `acct_${randomUUID().slice(0, 8)}`])).rows[0].id;
  const avaAccount = await account(ava);
  const benAccount = await account(ben);
  const { rows: [group] } = await db.query(
    `INSERT INTO groups (kind, name, created_by) VALUES ('roommates', 'Flat 7', $1) RETURNING id`, [ava]);
  await db.query('INSERT INTO group_members (group_id, user_id) VALUES ($1, $2), ($1, $3)', [group.id, ava, ben]);

  const tx = async (accountId, kind, direction, cents, name, occurredAt, { category = null, ref = `txn_${randomUUID().slice(0, 12)}` } = {}) => {
    const id = randomUUID();
    await db.query('INSERT INTO bank_import_keys (account_id, provider_key, transaction_id, occurred_at) VALUES ($1, $2, $3, $4)',
      [accountId, ref, id, occurredAt]);
    await db.query(
      `INSERT INTO bank_transactions (id, occurred_at, account_id, provider_transaction_id, kind, direction, amount_cents,
                                      status, description, merchant_name, category, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'completed', $8, $9, $10, 'nessie')`,
      [id, occurredAt, accountId, ref, kind, direction, cents, name, kind === 'purchase' ? name : null, category]);
    return { id, ref };
  };
  const expense = async ({ merchant, category = null, total, benShare, at, bank = null }) => {
    const { rows: [row] } = await db.query(
      `INSERT INTO expenses (group_id, created_by, merchant, category, total_cents, status, confirmed_at, bank_account_id, bank_provider_key)
       VALUES ($1, $2, $3, $4, $5, 'confirmed', $6, $7, $8) RETURNING id`,
      [group.id, ava, merchant, category, total, at, bank ? avaAccount : null, bank?.ref ?? null]);
    await db.query('INSERT INTO expense_shares (expense_id, user_id, share_cents) VALUES ($1, $2, $3), ($1, $4, $5)',
      [row.id, ava, total - benShare, ben, benShare]);
  };
  const settle = async (cents, createdAt) => {
    const ref = `txn_${randomUUID().slice(0, 12)}`;
    const { rows: [row] } = await db.query(
      `INSERT INTO settlements (group_id, created_by, payer_user_id, payee_user_id, payer_account_id, payee_account_id,
                                amount_cents, status, review_expires_at, provider_reference, posted_at, created_at)
       VALUES ($1, $2, $2, $3, $4, $5, $6, 'posted', now(), $7, $8, $8) RETURNING id`,
      [group.id, ben, ava, benAccount, avaAccount, cents, ref, createdAt]);
    const paid = await tx(benAccount, 'transfer', 'debit', cents, `Group settlement [${row.id}]`, createdAt, { ref });
    const received = await tx(avaAccount, 'transfer', 'credit', cents, `Group settlement [${row.id}]`, createdAt, { ref });
    return { id: row.id, paid, received };
  };

  // Ava paid $60 for pizza from her bank (Food & drink) and $20 for a cab in
  // cash (Getting around). Ben owes $30 + $10.
  const pizza = await tx(avaAccount, 'purchase', 'debit', 6_000, "Domino's", '2026-11-02T18:00:00Z', { category: 'Food & drink' });
  await expense({ merchant: "Domino's", total: 6_000, benShare: 3_000, at: '2026-11-02T19:00:00Z', bank: pizza });
  await expense({ merchant: 'Cab', category: 'Getting around', total: 2_000, benShare: 1_000, at: '2026-11-03T19:00:00Z' });

  // Ben settles $30 (the pizza), then $15 (the $10 cab and $5 nothing left to cover).
  const first = await settle(3_000, '2026-11-05T12:00:00Z');
  const second = await settle(1_500, '2026-11-06T12:00:00Z');
  assert.equal(await allocateMissingSettlements(db, ben), 2);
  await allocateSettlement(db, first.id); // repeat-safe
  const { rows: allocation } = await db.query(
    'SELECT settlement_id AS id, category, cents::int FROM settlement_categories ORDER BY settlement_id = $1 DESC, category', [first.id]);
  assert.deepEqual(allocation.map(({ category, cents }) => [category, cents]),
    [['Food & drink', 3_000], ['Getting around', 1_000], ['Other', 500]]);

  const range = parseRange({ from: '2026-11-01', to: '2026-11-14' });
  const categories = async (accountId) => Object.fromEntries((await getOverview(db, accountId, range)).breakdown.categories
    .map((row) => [row.category, row.cents]));
  // Ben: his settlements are spending in the categories they paid for.
  assert.deepEqual(await categories(benAccount), { 'Food & drink': 3_000, 'Getting around': 1_000, Other: 500 });
  // Ava: $60 pizza less $30 back; the cab was cash, so only reimbursements there.
  assert.deepEqual(await categories(avaAccount), { 'Food & drink': 3_000 });
  const avaOverview = await getOverview(db, avaAccount, range);
  assert.equal(avaOverview.totals.spentCents, 6_000 - 3_000 - 1_500);
  assert.equal(avaOverview.totals.earnedCents, 0, 'money back is not income');
  assert.deepEqual(avaOverview.settledWithSplit, { paidCents: 0, receivedCents: 4_500 });
  const received = avaOverview.recent.find((row) => row.id === first.received.id);
  assert.equal(received.countsAs, 'reimbursed');
  assert.equal(received.category, 'Food & drink');
  assert.deepEqual(received.settled, { group: 'Flat 7', with: 'Ben', direction: 'received', categories: [{ category: 'Food & drink', cents: 3_000 }] });

  // Transactions: Ben's $15 shows its main category, both lines, and filters by either.
  const benList = await listTransactions(db, ben, new URLSearchParams());
  const benSecond = benList.transactions.find((row) => row.id === second.paid.id);
  assert.equal(benSecond.settledWithSplit, true);
  assert.equal(benSecond.category, 'Getting around');
  assert.deepEqual(benSecond.settled.categories, [{ category: 'Getting around', cents: 1_000 }, { category: 'Other', cents: 500 }]);
  assert.ok(benList.categories.includes('Getting around'));
  const otherFilter = await listTransactions(db, ben, new URLSearchParams({ category: 'Other' }));
  assert.deepEqual(otherFilter.transactions.map((row) => row.id), [second.paid.id]);

  // Insights: monthly spending and categories include settlements.
  const insights = await createInsightsHandler({ withTransaction, now: () => new Date('2026-11-14T15:00:00Z') });
  const benInsights = await insights({ actor: { userId: ben } });
  assert.equal(benInsights.monthly.at(-1).spentCents, 4_500);
  assert.deepEqual(benInsights.settledWithSplit, { paidCents: 4_500, receivedCents: 0, currentPaidCents: 4_500, currentReceivedCents: 0, count: 2 });
  assert.deepEqual(benInsights.categories.map((row) => [row.category, row.totalCents]),
    [['Food & drink', 3_000], ['Getting around', 1_000], ['Other', 500]]);
  assert.deepEqual(benInsights.daily.map((row) => [row.day, row.spentCents]),
    [['2026-11-05', 3_000], ['2026-11-06', 1_500]]);
  const chartFilter = new URLSearchParams({ from: '2026-11-06', to: '2026-11-06', category: 'Other' });
  const benDrilldown = await listTransactions(db, ben, chartFilter);
  assert.deepEqual(benDrilldown.transactions.map(({ id, amountCents, spendingContributionCents }) =>
    [id, amountCents, spendingContributionCents]), [[second.paid.id, 1_500, 500]]);
  assert.deepEqual(benDrilldown.chartTotals, { incomeCents: 0, spendingCents: 500 });
  const avaDrilldown = await listTransactions(db, ava, chartFilter);
  assert.equal(avaDrilldown.transactions[0].spendingContributionCents, -500);
  assert.deepEqual(avaDrilldown.chartTotals, { incomeCents: 0, spendingCents: 0 });

  // Override: Ben files the $15 under Groceries; reset puts it back.
  const changed = await setTransactionCategory(db, ben, second.paid.id, { category: 'Groceries' });
  assert.equal(changed.transaction.category, 'Groceries');
  assert.deepEqual(await categories(benAccount), { 'Food & drink': 3_000, Groceries: 1_500 });
  const reset = await setTransactionCategory(db, ben, second.paid.id, { category: null });
  assert.equal(reset.transaction.category, 'Getting around');
  assert.deepEqual(await categories(benAccount), { 'Food & drink': 3_000, 'Getting around': 1_000, Other: 500 });
});
