// B4 acceptance: "With $50 available, requests for $40 and $30 cannot both
// reserve funds." Races a $40 goal contribution against a $30 settlement
// hold, each in its own transaction on its own connection, many times, on a
// throwaway schema (<DB_SCHEMA>_funds). Also checks that two requests that
// fit ($20 + $30) both succeed, so the lock serializes without over-blocking.
import { optionalEnv } from '../lib/env.js';

process.env.DB_SCHEMA = `${optionalEnv('DB_SCHEMA') || 'split'}_funds`;

const { closePool, dbSchema, getPool, withTransaction } = await import('../db/pool.js');
const { migrate } = await import('../db/migrate.js');
const { seed } = await import('../db/seed.js');
const { ACCOUNTS, GROUPS, USERS } = await import('../db/demo-ids.js');
const { InsufficientFundsError, getSpendableFunds, reserveFunds } = await import('../banking/funds.js');

const db = getPool();
const schema = dbSchema();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ROUNDS = 20;

async function reset(availableCents) {
  await db.query('DELETE FROM goal_movements');
  await db.query('DELETE FROM goals');
  await db.query('DELETE FROM settlements');
  await db.query(
    'UPDATE bank_accounts SET balance_cents = $2, available_cents = $2, balance_as_of = now() WHERE id = $1',
    [ACCOUNTS.maya, availableCents],
  );
}

// C5's shape: reserve, then persist the goal hold in the same transaction.
const goalContribution = (cents, delay) =>
  withTransaction(async (tx) => {
    await sleep(delay);
    await reserveFunds(tx, ACCOUNTS.maya, cents);
    await tx.query(
      `INSERT INTO goals (user_id, account_id, type, name, target_cents, saved_cents)
       VALUES ($1, $2, 'savings', 'Race test', 100000, $3)`,
      [USERS.maya, ACCOUNTS.maya, cents],
    );
    await sleep(40); // hold the lock a while so the other request really waits
    return `goal $${cents / 100}`;
  });

// A7's shape: reserve, then persist the settlement hold in the same transaction.
const settlementHold = (cents, delay) =>
  withTransaction(async (tx) => {
    await sleep(delay);
    await reserveFunds(tx, ACCOUNTS.maya, cents);
    await tx.query(
      `INSERT INTO settlements (group_id, created_by, payer_user_id, payee_user_id, payer_account_id,
                                payee_account_id, amount_cents, hold_cents, status, review_expires_at, claimed_at)
       VALUES ($1, $2, $2, $3, $4, $5, $6, $6, 'pending', now() + interval '10 minutes', now())`,
      [GROUPS.puffton4, USERS.maya, USERS.alex, ACCOUNTS.maya, ACCOUNTS.alex, cents],
    );
    await sleep(40);
    return `settlement $${cents / 100}`;
  });

let failed = false;
try {
  console.log(`Funds race check on throwaway schema "${schema}"`);
  await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await migrate({ log: () => {} });
  await seed({ log: () => {} });

  const winners = { goal: 0, settlement: 0 };
  let bad = 0;
  for (let i = 0; i < ROUNDS; i++) {
    await reset(5000);
    const [a, b] = [i % 2 ? 0 : 5, i % 2 ? 5 : 0]; // alternate who starts first
    const results = await Promise.allSettled([goalContribution(4000, a), settlementHold(3000, b)]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    const funds = await getSpendableFunds(ACCOUNTS.maya);
    const won = ok[0]?.value?.startsWith('goal') ? 4000 : 3000;
    const good =
      ok.length === 1 &&
      rejected.length === 1 &&
      rejected[0].reason instanceof InsufficientFundsError &&
      funds.spendableCents === 5000 - won &&
      funds.goalHoldsCents + funds.settlementHoldsCents === won;
    if (!good) {
      bad++;
      console.log(`  round ${i + 1}: ${results.map((r) => r.status + ' ' + (r.value ?? r.reason?.message)).join(' | ')} → spendable ${funds.spendableCents}`);
    } else winners[won === 4000 ? 'goal' : 'settlement']++;
  }
  console.log(
    `  ${bad ? 'FAIL' : 'PASS'}  $40 goal vs $30 settlement against $50: exactly one reserved in ${ROUNDS - bad}/${ROUNDS} rounds ` +
      `(goal won ${winners.goal}, settlement won ${winners.settlement}); the other got INSUFFICIENT_FUNDS`,
  );
  failed ||= bad > 0;

  await reset(5000);
  const both = await Promise.allSettled([goalContribution(2000, 0), settlementHold(3000, 0)]);
  const after = await getSpendableFunds(ACCOUNTS.maya);
  const fits = both.every((r) => r.status === 'fulfilled') && after.spendableCents === 0;
  console.log(`  ${fits ? 'PASS' : 'FAIL'}  $20 + $30 against $50 both reserve, leaving $${after.spendableCents / 100}`);
  failed ||= !fits;

  console.log(failed ? '\nB4 check: FAILED' : '\nB4 check: OK');
} catch (err) {
  failed = true;
  console.error('B4 check failed:', err.message);
} finally {
  await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
  await closePool();
  if (failed) process.exitCode = 1;
}
