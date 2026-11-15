// B12 · Overview across a user's checking account and credit card, against
// live Tiger Data. Opt in with RUN_OVERVIEW_DB_TESTS=1. Fresh throwaway schema.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

test('live database: Overview counts card purchases, ignores paying the card, and reports what is owed', {
  skip: process.env.RUN_OVERVIEW_DB_TESTS !== '1',
}, async (t) => {
  await import('../lib/env.js');
  const schema = `split_b_overview_${randomUUID().replaceAll('-', '')}`;
  process.env.DB_SCHEMA = schema;
  const { getPool, closePool } = await import('../db/pool.js');
  const { migrate } = await import('../db/migrate.js');
  const { getOverview, parseRange, accountIdForUser } = await import('../banking/overview.js');
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

  const { rows: [user] } = await db.query(
    `INSERT INTO users (handle, display_name, initials) VALUES ('ov-user', 'Olive', 'O') RETURNING id`);
  const { rows: [friend] } = await db.query(
    `INSERT INTO users (handle, display_name, initials) VALUES ('ov-friend', 'Finn', 'F') RETURNING id`);
  const account = async (kind, extra) => (await db.query(
    `INSERT INTO bank_accounts (user_id, provider, provider_account_id, kind, account_mask, balance_cents, available_cents,
                                credit_limit_cents, linked_at)
     VALUES ($1, 'nessie', $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [user.id, `acct_${randomUUID().slice(0, 8)}`, kind, ...extra])).rows[0].id;
  const checking = await account('checking', ['1111', 100_000, 100_000, null, new Date()]);
  const card = await account('credit_card', ['9876', -2_400, 197_600, 200_000, new Date()]);
  await db.query('UPDATE bank_accounts SET statement_due_day = 25 WHERE id = $1', [card]);

  const tx = async (accountId, kind, direction, cents, merchant, occurredAt = '2026-11-10T17:00:00Z') => {
    const id = randomUUID();
    const key = `nessie-${id.slice(0, 8)}`;
    await db.query(`INSERT INTO bank_import_keys (account_id, provider_key, transaction_id, occurred_at) VALUES ($1, $2, $3, $4)`,
      [accountId, key, id, occurredAt]);
    await db.query(
      `INSERT INTO bank_transactions (id, occurred_at, account_id, provider_transaction_id, kind, direction, amount_cents,
                                      status, description, merchant_name, category, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'completed', $8, $8, 'Food & drink', 'nessie')`,
      [id, occurredAt, accountId, key, kind, direction, cents, merchant]);
    return { id, key };
  };
  await tx(checking, 'deposit', 'credit', 50_000, 'Payroll');
  await tx(checking, 'purchase', 'debit', 1_200, 'Campus Café');
  const pizza = await tx(card, 'purchase', 'debit', 2_400, "Domino's");
  await tx(checking, 'transfer', 'debit', 2_400, 'Card payment');
  await tx(card, 'transfer', 'credit', 2_400, 'Payment received');

  // Someone else's card purchase never leaks in.
  const { rows: [other] } = await db.query(
    `INSERT INTO bank_accounts (user_id, provider, provider_account_id, kind, linked_at) VALUES ($1, 'nessie', 'acct_other', 'checking', now()) RETURNING id`,
    [friend.id]);
  await tx(other.id, 'purchase', 'debit', 99_900, 'Not yours');

  // Split the pizza with a group.
  const { rows: [group] } = await db.query(
    `INSERT INTO groups (kind, name, created_by) VALUES ('roommates', 'Flat 7', $1) RETURNING id`, [user.id]);
  await db.query(`INSERT INTO group_members (group_id, user_id) VALUES ($1, $2)`, [group.id, user.id]);
  await db.query(
    `INSERT INTO expenses (group_id, created_by, merchant, total_cents, status, confirmed_at, bank_account_id, bank_provider_key)
     VALUES ($1, $2, 'Pizza', 2400, 'confirmed', now(), $3, $4)`, [group.id, user.id, card, pizza.key]);

  assert.equal(await accountIdForUser(db, user.id), checking);
  const overview = await getOverview(db, checking, parseRange({ from: '2026-11-01', to: '2026-11-14' }));
  assert.equal(overview.account.id, checking);
  assert.deepEqual(overview.totals, { earnedCents: 50_000, spentCents: 3_600 });
  assert.deepEqual(overview.cards.map((c) => ({
    mask: c.mask, owed: c.owedCents, due: c.amountDueCents, limit: c.creditLimitCents,
  })), [{ mask: '9876', owed: 2_400, due: 2_400, limit: 200_000 }]);
  assert.match(overview.cards[0].dueDate, /^\d{4}-\d{2}-25$/u);
  assert.equal(overview.recent.length, 5);
  assert.ok(overview.recent.every((r) => r.merchantName !== 'Not yours'));
  const pizzaRow = overview.recent.find((r) => r.merchantName === "Domino's");
  assert.deepEqual({ kind: pizzaRow.accountKind, key: pizzaRow.providerKey, group: pizzaRow.splitGroupName },
    { kind: 'credit_card', key: pizza.key, group: 'Flat 7' });
  assert.equal(overview.recent.filter((r) => r.countsAs === 'spent').length, 2);
  assert.ok(overview.recent.filter((r) => r.kind === 'transfer').every((r) => r.countsAs === null));

  // Unlinking the card removes its activity from Overview.
  await db.query('UPDATE bank_accounts SET linked_at = NULL WHERE id = $1', [card]);
  const checkingOnly = await getOverview(db, checking, parseRange({ from: '2026-11-01', to: '2026-11-14' }));
  assert.deepEqual(checkingOnly.totals, { earnedCents: 50_000, spentCents: 1_200 });
  assert.deepEqual(checkingOnly.cards, []);
});
