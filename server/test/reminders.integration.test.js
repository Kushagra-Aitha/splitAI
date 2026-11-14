import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createReminderHandlers } from '../reminders/handlers.js';
import { createLedgerHandlers } from '../ledger/handlers.js';
import { createGoalHandlers } from '../goals/handlers.js';
import { createNotificationHandlers } from '../notifications/handlers.js';
import { createAskWorkflow } from '../assistant/workflow.js';

test('live database: reminders require confirmation and durable daily limits; goals history is scoped and paginated', {
  skip: process.env.RUN_REMINDERS_DB_TESTS !== '1',
}, async (t) => {
  const schema = `split_c_reminders_${randomUUID().replaceAll('-', '')}`;
  process.env.DB_SCHEMA = schema;
  const { getPool, withTransaction, closePool } = await import('../db/pool.js');
  const { migrate } = await import('../db/migrate.js');
  const { seed } = await import('../db/seed.js');
  const { USERS, ACCOUNTS } = await import('../db/demo-ids.js');
  const db = getPool(); let owned = false;
  t.after(async () => { try { if (owned) await db.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await closePool(); } });
  await db.query(`CREATE SCHEMA "${schema}"`); owned = true; await migrate({ log: () => {} }); await seed({ log: () => {} });
  await db.query("UPDATE users SET email = 'sam@split.test' WHERE id = $1", [USERS.sam]);
  const query = (...args) => db.query(...args), deps = { query, withTransaction };
  const reminders = createReminderHandlers(deps), ledger = createLedgerHandlers(deps), goals = createGoalHandlers(deps);
  const actor = { userId: USERS.maya };
  const group = async () => (await ledger['groups.create']({ actor, body: { name: `Reminder ${randomUUID()}`, kind: 'roommates', memberEmails: ['sam@split.test'] } })).group;
  const expense = async (g, cents = 3000) => {
    const { draft } = await ledger['expenseDrafts.create']({ actor, body: { groupId: g.id, merchant: 'Pizza', cents, participantIds: [USERS.maya, USERS.sam] } });
    await ledger['expenseDrafts.confirm']({ actor, params: { id: draft.id } }); return draft;
  };
  const make = (g, e, extra = {}) => reminders['reminders.draft']({ actor, body: { groupId: g.id, recipientUserId: USERS.sam, expenseId: e.id, requestKey: randomUUID(), ...extra } });
  const confirm = (r, by = actor) => reminders['reminders.confirm']({ actor: by, params: { id: r.id }, body: {} });
  let firstGroup, firstExpense;
  await t.test('one confirmed reminder across retries and concurrent sends, without any financial row changes', async () => {
    const g = firstGroup = await group(), e = firstExpense = await expense(g);
    const input = { groupId: g.id, recipientUserId: USERS.sam, expenseId: e.id, requestKey: randomUUID() };
    const { reminder } = await reminders['reminders.draft']({ actor, body: input });
    assert.equal(reminder.status, 'draft'); assert.equal(reminder.amountCents, 1500);
    assert.equal((await db.query("SELECT id FROM notifications WHERE kind = 'debt_reminder'")).rowCount, 0);
    assert.equal((await reminders['reminders.draft']({ actor, body: input })).reminder.id, reminder.id);
    const before = (await db.query('SELECT (SELECT count(*)::int FROM settlements) AS settlements, (SELECT count(*)::int FROM expenses) AS expenses')).rows[0];
    const result = await Promise.all([confirm(reminder), confirm(reminder)]);
    assert.ok(result.every((r) => r.type === 'reminder_sent'));
    assert.equal((await db.query("SELECT id FROM notifications WHERE kind = 'debt_reminder' AND source_id = $1", [reminder.id])).rowCount, 1);
    assert.deepEqual((await db.query('SELECT (SELECT count(*)::int FROM settlements) AS settlements, (SELECT count(*)::int FROM expenses) AS expenses')).rows[0], before);
    const notification = (await createNotificationHandlers({ query })['notifications.list']({ actor: { userId: USERS.sam }, query: new URLSearchParams() })).items.find((n) => n.kind === 'debt_reminder');
    assert.equal(notification.reminderCents, 1500); assert.equal(notification.groupId, g.id); assert.equal(notification.actorUserId, USERS.maya);
    await assert.rejects(confirm(reminder, { userId: USERS.alex }), (error) => error.status === 404);
    await assert.rejects(reminders['reminders.draft']({ actor, body: { ...input, recipientUserId: USERS.alex } }), (error) => error.status === 409);
  });
  await t.test('daily limit is per group/person debt even for another related expense', async () => {
    const next = await expense(firstGroup);
    const { reminder } = await make(firstGroup, next);
    await assert.rejects(confirm(reminder), (error) => error.code === 'REMINDER_DAILY_LIMIT');
    assert.equal((await db.query("SELECT id FROM notifications WHERE kind = 'debt_reminder'")).rowCount, 1);
  });
  await t.test('debt changes, expired drafts and departed recipients cannot send', async () => {
    const g = await group(), e = await expense(g), { reminder } = await make(g, e);
    await expense(g, 2000);
    await assert.rejects(confirm(reminder), (error) => error.code === 'DEBT_CHANGED');
    const expired = (await make(g, e)).reminder;
    await db.query("UPDATE debt_reminders SET expires_at = now() - interval '1 minute' WHERE id = $1", [expired.id]);
    await assert.rejects(confirm(expired), (error) => error.code === 'REMINDER_EXPIRED');
    const departed = (await make(g, e)).reminder;
    await db.query('UPDATE group_members SET left_at = now() WHERE group_id = $1 AND user_id = $2', [g.id, USERS.sam]);
    await assert.rejects(confirm(departed), (error) => error.status === 404);
  });
  await t.test('Ask resolves scoped reminder hints and requires choice for ambiguous expenses', async () => {
    const g = await group(); await expense(g); await expense(g);
    const ask = createAskWorkflow({ ...deps, prepareReminder: reminders.prepare, parseIntent: async () => ({ intent: 'reminder', expense: { merchant: 'Pizza', cents: null, participantNames: ['Sam'], groupHint: g.name } }) });
    const result = await ask({ actor, body: { message: 'Remind Sam about Pizza', requestKey: randomUUID() } });
    assert.equal(result.type, 'reminder_selection'); assert.equal(result.candidates.length, 2);
    assert.ok(result.candidates.every((c) => c.groupId === g.id && c.amountCents === 3000));
  });
  await t.test('goal history paginates without exposing another user and Ask reports canonical saved money', async () => {
    await db.query('UPDATE bank_accounts SET balance_cents = 100000, available_cents = 100000, linked_at = now(), balance_as_of = now() WHERE id = $1', [ACCOUNTS.maya]);
    const { goal } = await goals['goals.create']({ actor, body: { name: 'History goal', type: 'savings', targetCents: 10000, initialCents: 4000, requestKey: randomUUID() } });
    await db.query(`INSERT INTO goal_movements(goal_id, actor_user_id, kind, amount_cents, request_key)
      SELECT $1, $2, 'contribution', 1, gen_random_uuid()::text FROM generate_series(1, 24)`, [goal.id, USERS.maya]);
    await db.query('UPDATE goals SET saved_cents = 4024 WHERE id = $1', [goal.id]);
    const page = await goals['goals.history']({ actor, params: { id: goal.id }, query: new URLSearchParams() });
    const next = await goals['goals.history']({ actor, params: { id: goal.id }, query: new URLSearchParams({ before: page.nextCursor }) });
    assert.equal(page.items.length, 20); assert.equal(next.items.length, 5);
    assert.equal(new Set([...page.items, ...next.items].map((m) => m.id)).size, 25);
    await assert.rejects(goals['goals.history']({ actor: { userId: USERS.sam }, params: { id: goal.id }, query: new URLSearchParams() }), (error) => error.status === 403);
    const ask = createAskWorkflow({ ...deps, parseIntent: async () => ({ intent: 'goal_progress', expense: null }) });
    const result = await ask({ actor, body: { message: 'How am I doing on my goals?', requestKey: randomUUID() } });
    assert.equal(result.type, 'answer'); assert.equal(result.goals.find((g) => g.id === goal.id).savedCents, 4024);
  });
});
