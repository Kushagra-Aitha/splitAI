import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

test('live database: insights are actor-scoped, zero-filled and preserve fact labels', {
  skip: process.env.RUN_INSIGHTS_DB_TESTS !== '1',
}, async (t) => {
  await import('../lib/env.js');
  const schema = `split_c_insights_${randomUUID().replaceAll('-', '')}`;
  process.env.DB_SCHEMA = schema;
  const { getPool, withTransaction, closePool } = await import('../db/pool.js');
  const { migrate } = await import('../db/migrate.js');
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

  const makeUser = async (handle) => (await db.query(
    `INSERT INTO users(handle, display_name, initials) VALUES ($1, $1, 'I') RETURNING id`, [handle])).rows[0].id;
  const actorId = await makeUser('insight-owner');
  const otherId = await makeUser('insight-other');
  const account = async (userId, kind, mask) => (await db.query(
    `INSERT INTO bank_accounts(user_id, provider_account_id, kind, account_type, account_mask,
      balance_cents, available_cents, credit_limit_cents, linked_at)
     VALUES ($1,$2,$3,$4,$5,100000,80000,$6,now()) RETURNING id`,
    [userId, `acct_${randomUUID()}`, kind, kind === 'credit_card' ? 'Credit Card' : 'Checking', mask,
      kind === 'credit_card' ? 200000 : null])).rows[0].id;
  const checking = await account(actorId, 'checking', '1234');
  await account(actorId, 'credit_card', '9876');
  const foreign = await account(otherId, 'checking', '0000');

  const transaction = async (accountId, { date, kind = 'purchase', direction = 'debit', cents, name, category }) => {
    const id = randomUUID(), providerKey = `tx_${randomUUID()}`;
    await db.query(`INSERT INTO bank_import_keys(account_id, provider_key, transaction_id, occurred_at)
      VALUES ($1,$2,$3,$4)`, [accountId, providerKey, id, date]);
    await db.query(`INSERT INTO bank_transactions(id, occurred_at, account_id, provider_transaction_id, kind,
      direction, amount_cents, status, description, merchant_name, category, source)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'completed',$8,$9,$10,'nessie')`,
    [id, date, accountId, providerKey, kind, direction, cents, name, kind === 'purchase' ? name : null, category ?? null]);
    return providerKey;
  };
  await transaction(checking, { date: '2026-10-05T12:00:00Z', cents: 1200, name: 'C16 Cafe', category: 'Food & drink' });
  await transaction(checking, { date: '2026-11-05T12:00:00Z', cents: 1800, name: 'C16 Cafe', category: 'Food & drink' });
  await transaction(checking, { date: '2026-11-10T12:00:00Z', kind: 'deposit', direction: 'credit', cents: 250000, name: 'Payroll · Acme', category: 'Salary' });
  await transaction(foreign, { date: '2026-11-06T12:00:00Z', cents: 99999, name: 'Private merchant', category: 'Other' });
  const { rows: [goal] } = await db.query(`INSERT INTO goals(user_id, account_id, type, name, target_cents, saved_cents, target_date, created_at)
    VALUES ($1,$2,'trip','Japan',100000,25000,'2027-06-01','2026-10-01') RETURNING id`, [actorId, checking]);
  await db.query(`INSERT INTO goal_movements(goal_id, actor_user_id, kind, amount_cents, request_key, created_at)
    VALUES ($1,$2,'contribution',25000,$3,'2026-10-01')`, [goal.id, actorId, randomUUID()]);
  await db.query(`INSERT INTO capital_schedules(user_id, account_id, payee, amount_cents, day_of_month,
    next_due_on, first_due_on, request_key, kind, frequency, category) VALUES
    ($1,$2,'Rent',160000,15,'2026-11-15','2026-11-15',$3,'purchase','monthly','Housing'),
    ($1,$2,'SGI',69,null,'2026-11-18','2026-11-18',$4,'purchase','monthly','Other'),
    ($1,$2,'Acme',300000,null,'2026-11-15','2026-11-15',$5,'salary','biweekly','Salary')`,
  [actorId, checking, randomUUID(), randomUUID(), randomUUID()]);

  const read = createInsightsHandler({ withTransaction, now: () => new Date('2026-11-15T01:00:00Z') });
  const result = await read({ actor: { userId: actorId } });
  assert.equal(result.monthly.length, 12);
  assert.equal(result.monthly.find((month) => month.month === '2026-09').count, 0);
  assert.equal(result.monthly.find((month) => month.month === '2026-11').salaryCents, 250000);
  assert.deepEqual(result.categories.map((row) => row.category), ['Food & drink']);
  assert.equal(result.categories[0].currentCents, 1800);
  assert.equal(result.categories[0].averageCents, 1200);
  assert.ok(!result.merchants.some((row) => row.name === 'Private merchant'));
  assert.deepEqual(result.goals.map((goal) => goal.name), ['Japan']);
  assert.equal(result.cards[0].usedCents, 120000);
  assert.equal(result.cards[0].dueDate, null);
  assert.deepEqual(result.upcomingSchedules.map((schedule) => schedule.name).sort(), ['Acme', 'Rent', 'SGI']);
  assert.deepEqual(Object.fromEntries(result.upcomingSchedules.map((schedule) => [schedule.name, schedule.recurring])),
    { Acme: true, Rent: true, SGI: false });
  assert.equal(result.calendar.days.find((day) => day.date === '2026-11-15').cents, 160000);
  assert.equal(result.calendar.days.find((day) => day.date === '2026-11-18').cents, 69);
  assert.ok(!result.calendar.days.some((day) => day.cents === 300000));
  assert.match(result.allocation.note, /not bank outflows/);
  assert.equal(result.hasActivity, true);
});
