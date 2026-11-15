import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createAskWorkflow } from '../assistant/workflow.js';
import { createLedgerHandlers } from '../ledger/handlers.js';
import { HttpError } from '../http.js';

test('live database: Ask resolves selections and creates one draft that only explicit confirmation commits', {
  skip: process.env.RUN_ASK_DB_TESTS !== '1',
}, async (t) => {
  await import('../lib/env.js');
  const schema = `split_c_ask_${randomUUID().replaceAll('-', '')}`;
  process.env.DB_SCHEMA = schema;
  const { getPool, withTransaction, closePool } = await import('../db/pool.js');
  const { migrate } = await import('../db/migrate.js');
  const { seed } = await import('../db/seed.js');
  const { USERS, GROUPS } = await import('../db/demo-ids.js');
  const db = getPool();
  let owned = false;
  t.after(async () => {
    try { if (owned) await db.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await closePool(); }
  });
  await db.query(`CREATE SCHEMA "${schema}"`);
  owned = true;
  await migrate({ log: () => {} });
  await seed({ log: () => {} });
  for (const handle of ['sam', 'priya', 'alex']) {
    await db.query('UPDATE users SET email = $2 WHERE handle = $1', [handle, `${handle}@split.test`]);
  }
  const actor = { userId: USERS.maya };
  const query = (...args) => db.query(...args);
  const ledger = createLedgerHandlers({ query, withTransaction });
  let modelCalls = 0;
  let expense = { merchant: 'Antonio’s', cents: 4200, participantNames: ['Sam', 'Priya'], groupHint: null };
  let modelError = false;
  const ask = createAskWorkflow({ query, withTransaction, parseIntent: async () => {
    modelCalls++;
    if (modelError) throw new HttpError(502, 'INVALID_ASSISTANT_OUTPUT', 'Try again.');
    return { intent: 'expense', expense };
  } });
  const count = async (table, where = '') => (await db.query(`SELECT count(*)::int AS n FROM ${table} ${where}`)).rows[0].n;
  const begin = (message = 'Spent $42 at Antonio’s, split with Sam and Priya.') => ({ message, requestKey: randomUUID() });

  await t.test('ambiguous groups require selection; retrying selection creates one durable draft', async () => {
    const body = begin();
    const selection = await ask({ actor, body });
    assert.equal(selection.type, 'selection_needed');
    assert.equal(selection.reason, 'GROUP_REQUIRED');
    assert.equal(selection.groups.length, 2);
    assert.equal(await count('expenses'), 0);
    const choose = { proposalId: selection.proposalId, selection: { groupId: GROUPS.puffton4 } };
    const [first, second] = await Promise.all([ask({ actor, body: choose }), ask({ actor, body: choose })]);
    assert.equal(first.type, 'draft');
    assert.equal(first.draft.id, second.draft.id);
    assert.deepEqual(first.draft.shares.map((share) => share.cents), [1400, 1400, 1400]);
    assert.equal(first.draft.payerUserId, USERS.maya);
    assert.equal(await count('expenses'), 1);
    assert.equal(await count('expenses', "WHERE status = 'confirmed'"), 0);
    const retry = await ask({ actor, body });
    assert.equal(retry.draft.id, first.draft.id);
    assert.equal(modelCalls, 1);
    const confirmed = await ledger['expenseDrafts.confirm']({ actor, params: { id: first.draft.id } });
    assert.equal(confirmed.expense.status, 'confirmed');
    assert.deepEqual(await ledger['expenseDrafts.confirm']({ actor, params: { id: first.draft.id } }), confirmed);
    assert.equal((await ask({ actor, body })).draft.status, 'confirmed');
    const { debts, ledger: entries } = await ledger['groups.get']({ actor, params: { id: GROUPS.puffton4 } });
    assert.equal(debts.owedToYouCents, 2800);
    assert.equal(entries.filter((entry) => entry.type === 'expense').length, 1);
    await assert.rejects(ask({ actor, body: { ...body, message: 'Different expense' } }), (error) => error.code === 'REQUEST_KEY_REUSED');
    await assert.rejects(ask({ actor, body: { proposalId: selection.proposalId, selection: {
      groupId: GROUPS.puffton4, merchant: 'Different merchant',
    } } }), (error) => error.code === 'PROPOSAL_ALREADY_REVIEWED');
  });

  await t.test('a request key is durable under concurrent initial retries', async () => {
    expense = { ...expense, groupHint: 'Puffton 4' };
    const body = begin('A second synthetic expense');
    const before = await count('expenses');
    const [a, b] = await Promise.all([ask({ actor, body }), ask({ actor, body })]);
    assert.equal(a.type, 'draft');
    assert.equal(a.draft.id, b.draft.id);
    assert.equal(await count('expenses'), before + 1);
  });

  await t.test('ambiguous names require an explicit eligible identity selection', async () => {
    const otherSam = randomUUID();
    await db.query(`INSERT INTO users (id, handle, display_name, full_name, initials, email)
      VALUES ($1, 'synthetic_sam', 'Sam', 'Sam Example', 'SE', 'other-sam@split.test')`, [otherSam]);
    const { group } = await ledger['groups.create']({ actor, body: {
      kind: 'roommates', name: 'Synthetic duplicate names', memberEmails: ['sam@split.test', 'other-sam@split.test'],
    } });
    expense = { ...expense, groupHint: group.name, participantNames: ['Sam'] };
    const selection = await ask({ actor, body: begin('Ambiguous Sam expense') });
    assert.equal(selection.type, 'selection_needed');
    assert.equal(selection.reason, 'MEMBERS_REQUIRED');
    assert.deepEqual(selection.unresolvedNames, ['Sam']);
    assert.equal(selection.members.filter((member) => member.displayName === 'Sam').length, 2);
    const draft = await ask({ actor, body: { proposalId: selection.proposalId, selection: {
      groupId: group.id, participantIds: [otherSam],
    } } });
    assert.deepEqual(new Set(draft.draft.shares.map((share) => share.userId)), new Set([USERS.maya, otherSam]));
  });

  await t.test('missing details can be supplied explicitly without another model call', async () => {
    expense = { merchant: null, cents: null, participantNames: [], groupHint: 'Boston weekend' };
    const selection = await ask({ actor, body: begin('Split something') });
    assert.equal(selection.type, 'selection_needed');
    assert.deepEqual(selection.missingFields, ['merchant', 'cents', 'participantNames']);
    const before = modelCalls;
    const draft = await ask({ actor, body: { proposalId: selection.proposalId, selection: {
      groupId: GROUPS.bostonWeekend, participantIds: [USERS.sam], merchant: 'Lunch', cents: 1000,
    } } });
    assert.equal(draft.draft.totalCents, 1000);
    assert.equal(modelCalls, before);
  });

  await t.test('cross-actor proposals and participants from another group are rejected', async () => {
    expense = { merchant: 'Synthetic', cents: 1000, participantNames: ['Unknown'], groupHint: null };
    const selection = await ask({ actor, body: begin('Scope check expense') });
    const before = await count('expenses');
    const foreignProposal = await ask({ actor: { userId: USERS.sam }, body: {
      proposalId: selection.proposalId, selection: { groupId: GROUPS.bostonWeekend },
    } });
    assert.equal(foreignProposal.type, 'blocked');
    assert.equal(foreignProposal.reasonCode, 'ASSISTANT_SCOPE_REJECTED');
    const foreignMember = await ask({ actor, body: { proposalId: selection.proposalId, selection: {
      groupId: GROUPS.bostonWeekend, participantIds: [USERS.alex],
    } } });
    assert.equal(foreignMember.type, 'blocked');
    assert.equal(foreignMember.reasonCode, 'ASSISTANT_SCOPE_REJECTED');
    assert.equal(await count('expenses'), before);
  });

  await t.test('a group created after the proposal is available for explicit selection', async () => {
    expense = { merchant: 'Lunch', cents: 1001, participantNames: ['Sam'], groupHint: null };
    const selection = await ask({ actor, body: begin('Create a group for this split') });
    assert.equal(selection.reason, 'GROUP_REQUIRED');
    const { group } = await ledger['groups.create']({ actor, body: {
      kind: 'roommates', name: 'New Ask group', memberEmails: ['sam@split.test'],
    } });
    const review = await ask({ actor, body: { proposalId: selection.proposalId, selection: { groupId: group.id } } });
    assert.equal(review.type, 'draft');
    assert.equal(review.draft.groupId, group.id);
    assert.equal(review.draft.shares.reduce((sum, share) => sum + share.cents, 0), 1001);
  });

  await t.test('a failed proposal binding rolls back the draft and shares, then retries safely', async () => {
    expense = { merchant: 'Lunch', cents: 1000, participantNames: ['Sam'], groupHint: 'Puffton 4' };
    const body = begin('Atomic binding test');
    const before = await count('expenses');
    const sharesBefore = await count('expense_shares');
    const failing = createAskWorkflow({ query, parseIntent: async () => ({ intent: 'expense', expense }),
      withTransaction: (fn) => withTransaction((db) => fn({ query: (sql, ...args) => {
        if (sql.startsWith('UPDATE assistant_proposals')) throw new Error('Synthetic binding failure');
        return db.query(sql, ...args);
      } })),
    });
    await assert.rejects(failing({ actor, body }), /Synthetic binding failure/);
    assert.equal(await count('expenses'), before);
    assert.equal(await count('expense_shares'), sharesBefore);
    const review = await ask({ actor, body });
    assert.equal(review.type, 'draft');
    assert.equal(await count('expenses'), before + 1);
  });

  await t.test('expired proposals and invalid model output create no expense', async () => {
    expense = { merchant: 'Synthetic', cents: 1000, participantNames: ['Unknown'], groupHint: null };
    const selection = await ask({ actor, body: begin('Expiring proposal') });
    await db.query("UPDATE assistant_proposals SET expires_at = now() - interval '1 second' WHERE id = $1", [selection.proposalId]);
    const before = await count('expenses');
    await assert.rejects(ask({ actor, body: { proposalId: selection.proposalId, selection: {
      groupId: GROUPS.puffton4, participantIds: [USERS.sam],
    } } }), (error) => error.status === 409 && error.code === 'PROPOSAL_EXPIRED');
    modelError = true;
    const rejected = await ask({ actor, body: begin('Bad model output') });
    assert.equal(rejected.type, 'blocked');
    assert.equal(rejected.reasonCode, 'ASSISTANT_PROPOSAL_REJECTED');
    assert.equal(await count('expenses'), before);
  });
});
