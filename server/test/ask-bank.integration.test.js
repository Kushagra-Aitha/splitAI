import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createAskWorkflow } from '../assistant/workflow.js';
import { bankQuery } from '../assistant/bank-match.js';
import { createLedgerHandlers } from '../ledger/handlers.js';

test('live database: Ask resolves real actor-owned purchases and only drafts reviewed bank-linked expenses', {
  skip: process.env.RUN_ASK_BANK_DB_TESTS !== '1',
}, async (t) => {
  const schema = `split_c_abank_${randomUUID().replaceAll('-', '')}`;
  process.env.DB_SCHEMA = schema;
  const { getPool, withTransaction, closePool } = await import('../db/pool.js');
  const { migrate } = await import('../db/migrate.js');
  const { seed } = await import('../db/seed.js');
  const { USERS, ACCOUNTS, GROUPS } = await import('../db/demo-ids.js');
  const db = getPool(); let owned = false;
  t.after(async () => { try { if (owned) await db.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await closePool(); } });
  await db.query(`CREATE SCHEMA "${schema}"`); owned = true; await migrate({ log: () => {} }); await seed({ log: () => {} });
  await db.query('UPDATE bank_accounts SET linked_at = now()');
  const { rows: [card] } = await db.query(`INSERT INTO bank_accounts (user_id, kind, account_type, provider_account_id, linked_at)
    VALUES ($1, 'credit_card', 'Credit Card', $2, now()) ON CONFLICT (user_id, kind)
    DO UPDATE SET linked_at = now() RETURNING id`, [USERS.maya, `synthetic-${randomUUID()}`]);
  const query = (...args) => db.query(...args), actor = { userId: USERS.maya };
  const ledger = createLedgerHandlers({ query, withTransaction });
  const criteria = bankQuery("Split last night's Domino's", { merchant: "Domino's", cents: null });
  const imported = async (merchant, accountId = card.id, cents = 2400) => {
    const providerKey = `synthetic-${randomUUID()}`, id = randomUUID();
    const { rows: [time] } = await db.query("SELECT (($1::date::timestamp + interval '20 hours') AT TIME ZONE 'America/New_York') AS at", [criteria.from]);
    await db.query(`INSERT INTO bank_import_keys (account_id, provider_key, transaction_id, occurred_at, source) VALUES ($1, $2, $3, $4, 'nessie')`, [accountId, providerKey, id, time.at]);
    await db.query(`INSERT INTO bank_transactions (id, occurred_at, account_id, provider_transaction_id, kind, direction,
      amount_cents, status, merchant_name, description, source) VALUES ($1, $2, $3, $4, 'purchase', 'debit', $5, 'completed', $6, $6, 'nessie')`,
    [id, time.at, accountId, providerKey, cents, merchant]);
    return { accountId, providerKey };
  };
  const makeAsk = (merchant, cents = null) => {
    const messages = [];
    const ask = createAskWorkflow({ query, withTransaction, parseIntent: async (message) => {
      messages.push(message);
      return { intent: 'expense', expense: { merchant, cents, participantNames: ['Sam'], groupHint: 'Puffton 4' } };
    } });
    return { ask, messages };
  };
  await t.test('last-night matching uses the card record, retains its reference on retry, and confirms only once', async () => {
    const reference = await imported("Domino's");
    await imported("Domino's", ACCOUNTS.sam);
    const { ask, messages } = makeAsk("Domino's");
    const body = { message: "Split last night's Domino's with Sam in Puffton 4.", requestKey: randomUUID() };
    const result = await ask({ actor, body });
    assert.equal(result.type, 'draft'); assert.equal(result.draft.totalCents, 2400);
    assert.deepEqual(result.draft.bankRef, reference); assert.equal(result.draft.status, 'draft');
    const replay = await ask({ actor, body }); assert.equal(replay.draft.id, result.draft.id); assert.deepEqual(replay.draft.bankRef, reference);
    assert.deepEqual(messages, [body.message]);
    await ledger['expenseDrafts.confirm']({ actor, params: { id: result.draft.id } });
    await ledger['expenseDrafts.confirm']({ actor, params: { id: result.draft.id } });
    assert.equal((await db.query("SELECT id FROM expenses WHERE bank_account_id = $1 AND bank_provider_key = $2 AND status = 'confirmed'", [reference.accountId, reference.providerKey])).rowCount, 1);
    const again = await ask({ actor, body: { ...body, requestKey: randomUUID() } });
    assert.equal(again.type, 'selection_needed'); assert.equal(again.bankCandidates.length, 0);
    const stored = (await db.query('SELECT bank_query, message_hash FROM assistant_proposals WHERE id = $1', [result.proposalId])).rows[0];
    assert.equal(stored.bank_query.from, criteria.from); assert.ok(!JSON.stringify(stored).includes(body.message));
  });
  await t.test('ambiguity requires explicit purchase choice; foreign IDs and changed amounts cannot choose terms', async () => {
    const first = await imported('Amazon', card.id, 4600); await imported('Amazon', ACCOUNTS.maya, 6200);
    const foreign = await imported('Amazon', ACCOUNTS.sam, 4600);
    const { ask } = makeAsk('Amazon');
    const result = await ask({ actor, body: { message: 'Split yesterday Amazon with Sam in Puffton 4', requestKey: randomUUID() } });
    assert.equal(result.type, 'selection_needed'); assert.equal(result.bankCandidates.length, 2);
    assert.ok(result.missingFields.includes('bankPurchase'));
    await assert.rejects(ask({ actor, body: { proposalId: result.proposalId, selection: { groupId: GROUPS.puffton4, bankRef: foreign } } }), (error) => error.code === 'BANK_PURCHASE_UNAVAILABLE');
    await assert.rejects(ask({ actor, body: { proposalId: result.proposalId, selection: { groupId: GROUPS.puffton4, bankRef: first, cents: 1 } } }), (error) => error.status === 422);
    const selected = await ask({ actor, body: { proposalId: result.proposalId, selection: { groupId: GROUPS.puffton4, bankRef: first } } });
    assert.equal(selected.type, 'draft'); assert.equal(selected.draft.totalCents, 4600); assert.deepEqual(selected.draft.bankRef, first);
  });
  await t.test('declined or unshared purchases fail revalidation before confirmation', async () => {
    const reference = await imported('Delta flight', card.id, 38900);
    const { ask } = makeAsk('Delta flight');
    const result = await ask({ actor, body: { message: 'Split yesterday Delta flight with Sam in Puffton 4', requestKey: randomUUID() } });
    assert.equal(result.type, 'draft');
    await db.query("UPDATE bank_transactions SET status = 'declined' WHERE account_id = $1 AND provider_transaction_id = $2", [reference.accountId, reference.providerKey]);
    await assert.rejects(ledger['expenseDrafts.confirm']({ actor, params: { id: result.draft.id } }), (error) => error.status === 422);
    assert.equal((await db.query('SELECT status FROM expenses WHERE id = $1', [result.draft.id])).rows[0].status, 'draft');
    await db.query("UPDATE bank_transactions SET status = 'completed' WHERE account_id = $1 AND provider_transaction_id = $2", [reference.accountId, reference.providerKey]);
    await db.query('UPDATE bank_accounts SET linked_at = NULL WHERE id = $1', [card.id]);
    await assert.rejects(ledger['expenseDrafts.confirm']({ actor, params: { id: result.draft.id } }), (error) => error.status === 422);
  });
});
