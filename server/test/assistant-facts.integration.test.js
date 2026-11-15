import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { readFinancialFacts } from '../assistant/facts.js';
import { createFactExplainer, createFinancialAnswers } from '../assistant/answers.js';
import { createAskWorkflow } from '../assistant/workflow.js';
import { createGroundedResponder, readAskTransactions } from '../assistant/conversation.js';

test('grounded conversational phrasing rejects invented amounts and financial actions', async () => {
  const facts = { first: '2026-11-14: Domino’s, $42.00 debit, Food, completed.' };
  const valid = createGroundedResponder({ generate: async () => ({
    answer: 'Domino’s was a $42.00 debit on 2026-11-14.', factIds: ['first'],
  }) });
  assert.equal(await valid(facts), 'Domino’s was a $42.00 debit on 2026-11-14.');
  for (const answer of ['Domino’s was $99.00.', 'Send $42.00 now.']) {
    const rejected = createGroundedResponder({ generate: async () => ({ answer, factIds: ['first'] }) });
    assert.equal(await rejected(facts), facts.first);
  }
});

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
  await db.query('UPDATE bank_accounts SET linked_at = coalesce(linked_at, now())');
  await db.query('UPDATE bank_accounts SET balance_cents = 5000, available_cents = 5000, balance_as_of = now(), linked_at = coalesce(linked_at, now()) WHERE id = $1', [ACCOUNTS.maya]);
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
  const transactionFilter = { merchant: null, category: null, direction: null, status: null,
    from: '2026-11-14', to: '2026-11-14', limit: 10 };
  const mayaTransactions = await readAskTransactions({ withTransaction, actorId: USERS.maya, filter: transactionFilter, now });
  assert.equal(mayaTransactions.transactions.length, 1);
  assert.equal(mayaTransactions.transactions[0].amountCents, 1234);
  assert.equal((await readAskTransactions({ withTransaction, actorId: USERS.alex, filter: transactionFilter, now })).transactions.length, 0);
  const answerFinancial = createFinancialAnswers({ withTransaction, now: () => now,
    explain: createFactExplainer({ generate: async ({ input }) => ({ statementIds: Object.keys(input.statements) }) }),
  });
  const ask = createAskWorkflow({ query: (...args) => db.query(...args), withTransaction, answerFinancial,
    parseIntent: async () => ({ intent: 'affordability', expense: null }),
  });
  const none = await ask({ actor: { userId: USERS.maya }, body: { message: 'Which debts fit?', requestKey: randomUUID() } });
  assert.equal(none.plan.coverage, 'none');
  assert.equal(none.plan.spendableCents, 100);
  await db.query('UPDATE bank_accounts SET balance_cents = 3000, available_cents = 3000 WHERE id = $1', [ACCOUNTS.maya]);
  const all = await answerFinancial({ actor: { userId: USERS.maya }, intent: 'affordability' });
  assert.equal(all.plan.coverage, 'all');
  assert.equal(all.plan.remainingCents, 1000);
  const insight = await answerFinancial({ actor: { userId: USERS.maya }, intent: 'spending_insight', query });
  assert.ok(insight.answer.includes('2026-11-14 through 2026-11-14'));
  assert.ok(insight.answer.includes('$12.34'));
  assert.equal((await db.query("SELECT count(*)::int AS n FROM expenses WHERE status = 'confirmed'")).rows[0].n, 1);
});
