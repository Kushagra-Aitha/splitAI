import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { listGoals } from '../goals/read.js';

test('live database: goal reads are actor-scoped, exact, and derived from durable movements', {
  skip: process.env.RUN_GOALS_DB_TESTS !== '1',
}, async (t) => {
  // Load credentials without printing them. Every run creates a fresh namespace;
  // never migrate, seed, or clean up the configured working/shared schema.
  await import('../lib/env.js');
  const schema = `split_c_goals_${randomUUID().replaceAll('-', '')}`;
  process.env.DB_SCHEMA = schema;
  const { getPool, closePool } = await import('../db/pool.js');
  const { migrate } = await import('../db/migrate.js');
  const { seed } = await import('../db/seed.js');
  const { ACCOUNTS, USERS } = await import('../db/demo-ids.js');
  const db = getPool();
  let owned = false;
  t.after(async () => {
    try {
      if (owned) await db.query(`DROP SCHEMA "${schema}" CASCADE`);
    } finally {
      await closePool();
    }
  });
  // CREATE without IF NOT EXISTS fails safely on even an improbable collision.
  await db.query(`CREATE SCHEMA "${schema}"`);
  owned = true;
  await migrate({ log: () => {} });
  await seed({ log: () => {} });
  const goalId = randomUUID();
  await db.query(`INSERT INTO goals (id, user_id, account_id, name, type, target_cents, saved_cents)
    VALUES ($1, $2, $3, 'Synthetic savings', 'savings', 10000, 3000)`, [goalId, USERS.maya, ACCOUNTS.maya]);
  await db.query(`INSERT INTO goal_movements (goal_id, actor_user_id, kind, amount_cents, request_key)
    VALUES ($1, $2, 'contribution', 3000, $3)`, [goalId, USERS.maya, randomUUID()]);
  await db.query(`INSERT INTO goals (user_id, account_id, name, type, target_cents)
    VALUES ($1, $2, 'Other actor', 'savings', 10000), ($3, $2, 'Mismatched owner', 'savings', 10000)`,
  [USERS.sam, ACCOUNTS.sam, USERS.maya]);

  const maya = await listGoals(db, USERS.maya);
  assert.equal(maya.goals.length, 1);
  assert.equal(maya.goals[0].id, goalId);
  assert.equal(maya.goals[0].savedCents, 3000);
  assert.equal((await listGoals(db, USERS.sam)).goals.length, 1);
  assert.equal((await listGoals(db, USERS.alex)).goals.length, 0);

  await db.query(`INSERT INTO goal_movements (goal_id, actor_user_id, kind, amount_cents, request_key)
    VALUES ($1, $2, 'withdrawal', 1000, $3)`, [goalId, USERS.maya, randomUUID()]);
  await db.query('UPDATE goals SET saved_cents = 2000 WHERE id = $1', [goalId]);
  assert.equal((await listGoals(db, USERS.maya)).goals[0].savedCents, 2000);
  await db.query('UPDATE goals SET saved_cents = 2500 WHERE id = $1', [goalId]);
  await assert.rejects(listGoals(db, USERS.maya), (error) => error.code === 'GOAL_STATE_INVALID');
});
