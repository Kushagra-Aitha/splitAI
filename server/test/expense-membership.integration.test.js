import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createLedgerHandlers } from '../ledger/handlers.js';

test('live database: expense confirmation rechecks and locks all participant memberships', {
  skip: process.env.RUN_LEDGER_DB_TESTS !== '1',
}, async (t) => {
  await import('../lib/env.js');
  const schema = `split_c_members_${randomUUID().replaceAll('-', '')}`;
  process.env.DB_SCHEMA = schema;
  const { getPool, withTransaction, closePool } = await import('../db/pool.js');
  const { migrate } = await import('../db/migrate.js');
  const { seed } = await import('../db/seed.js');
  const { USERS } = await import('../db/demo-ids.js');
  const db = getPool();
  let owned = false;
  t.after(async () => {
    try {
      if (owned) await db.query(`DROP SCHEMA "${schema}" CASCADE`);
    } finally {
      await closePool();
    }
  });
  // A fresh namespace per run; never touch the configured working schema.
  await db.query(`CREATE SCHEMA "${schema}"`);
  owned = true;
  await migrate({ log: () => {} });
  await seed({ log: () => {} });
  const actor = { userId: USERS.maya };
  const ledger = createLedgerHandlers({ query: (...args) => db.query(...args), withTransaction });

  async function review(cents = 4200) {
    const { group } = await ledger['groups.create']({ actor, body: {
      name: 'Synthetic membership test', kind: 'roommates', memberIds: [USERS.sam, USERS.priya],
    } });
    const { draft } = await ledger['expenseDrafts.create']({ actor, body: {
      groupId: group.id, merchant: 'Synthetic shared expense', cents,
      participantIds: [USERS.maya, USERS.sam, USERS.priya],
    } });
    return draft;
  }
  const confirm = (draft) => ledger['expenseDrafts.confirm']({ actor, params: { id: draft.id } });
  const removeSam = (groupId, client = db) => client.query(
    'DELETE FROM group_members WHERE group_id = $1 AND user_id = $2', [groupId, USERS.sam],
  );

  await t.test('unchanged memberships confirm once and repeated confirmation returns the same expense', async () => {
    const draft = await review();
    const first = await confirm(draft);
    assert.equal(first.expense.status, 'confirmed');
    assert.deepEqual(await confirm(draft), first);
    const { rows: [{ count }] } = await db.query(
      "SELECT count(*)::int AS count FROM expenses WHERE id = $1 AND status = 'confirmed'", [draft.id],
    );
    assert.equal(count, 1);
    // Historical replay creates no new obligations and stays repeat-safe after
    // a former participant leaves. It does not authorize a new confirmation.
    await removeSam(draft.groupId);
    assert.deepEqual(await confirm(draft), first);
  });

  await t.test('a removed share participant blocks confirmation without changing the draft or debts', async () => {
    const draft = await review();
    await removeSam(draft.groupId);
    await assert.rejects(confirm(draft), (error) => error.status === 403 && error.code === 'PARTICIPANT_NOT_A_MEMBER');
    const { rows: [stored] } = await db.query('SELECT status, confirmed_at FROM expenses WHERE id = $1', [draft.id]);
    assert.equal(stored.status, 'draft');
    assert.equal(stored.confirmed_at, null);
    const { debts, ledger: entries } = await ledger['groups.get']({ actor, params: { id: draft.groupId } });
    assert.equal(debts.youOweCents, 0);
    assert.equal(debts.owedToYouCents, 0);
    assert.equal(entries.length, 0);
  });

  await t.test('zero-cent share participants must also remain group members', async () => {
    const draft = await review(1);
    assert.equal(draft.shares.find((share) => share.userId === USERS.sam).cents, 0);
    await removeSam(draft.groupId);
    await assert.rejects(confirm(draft), (error) => error.status === 403 && error.code === 'PARTICIPANT_NOT_A_MEMBER');
  });

  await t.test('participant removal cannot race past the confirmation membership check', async () => {
    const draft = await review();
    const checked = Promise.withResolvers();
    const release = Promise.withResolvers();
    const paused = createLedgerHandlers({
      query: (...args) => db.query(...args),
      withTransaction: (fn) => withTransaction(async (tx) => {
        const result = await fn(tx);
        checked.resolve();
        await release.promise;
        return result;
      }),
    });
    const confirmation = paused['expenseDrafts.confirm']({ actor, params: { id: draft.id } });
    // Surface an unexpected failure before the pause rather than hanging.
    confirmation.catch(checked.reject);
    let remover;
    try {
      await checked.promise;
      remover = await db.connect();
      await remover.query('BEGIN');
      await remover.query("SET LOCAL lock_timeout = '200ms'");
      await assert.rejects(removeSam(draft.groupId, remover), (error) => error.code === '55P03');
    } finally {
      if (remover) {
        await remover.query('ROLLBACK');
        remover.release();
      }
      release.resolve();
      await confirmation;
    }
    assert.equal((await removeSam(draft.groupId)).rowCount, 1);
  });
});
