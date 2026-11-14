// F2 acceptance check: "A fresh schema migrates and seeds twice safely."
// Uses a throwaway schema (<DB_SCHEMA>_verify), never your working schema:
// drop it → migrate + seed → migrate + seed again → compare → drop it.
import { optionalEnv } from '../lib/env.js';

process.env.DB_SCHEMA = `${optionalEnv('DB_SCHEMA') || 'split'}_verify`;

const { closePool, dbSchema, getPool } = await import('../db/pool.js');
const { migrate } = await import('../db/migrate.js');
const { seed } = await import('../db/seed.js');
const { inspectSchema } = await import('./db-check-lib.js');

const schema = dbSchema();
const db = getPool();
const quiet = () => {};
let failed = false;
const check = (ok, label) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failed = true;
};

try {
  console.log(`Verifying on throwaway schema "${schema}"`);
  await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);

  await migrate({ log: quiet });
  await seed({ log: quiet });
  const first = await inspectSchema(db, schema);

  await migrate({ log: quiet });
  await seed({ log: quiet });
  const second = await inspectSchema(db, schema);

  check(Object.values(first.counts).every((n) => n !== null), 'all 13 base tables exist');
  check(JSON.stringify(first.counts) === JSON.stringify(second.counts), 'second migrate + seed adds no rows');
  check(second.migrations.length === first.migrations.length, 'second migrate applies nothing new');
  check(first.counts.users === 4 && first.counts.bank_accounts === 4, '4 demo users with 4 accounts');
  check(first.counts.groups === 2 && first.counts.group_members === 7, 'Puffton 4 (4 members) + Boston weekend (3)');
  if (first.hypertable !== null) check(first.hypertable, 'bank_transactions is a hypertable');
  else console.log('  SKIP  hypertable check (TimescaleDB not installed)');

  console.log(failed ? '\nF2 verify: FAILED' : '\nF2 verify: OK');
} catch (err) {
  failed = true;
  console.error('Verify failed:', err.message);
} finally {
  await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
  await closePool();
  if (failed) process.exitCode = 1;
}
