// Connects with server/.env and reports server, TimescaleDB and the state of
// DB_SCHEMA: applied migrations, row counts, and whether bank_transactions is
// a hypertable. Read-only.
import { closePool, dbSchema, getPool } from '../db/pool.js';
import { inspectSchema } from './db-check-lib.js';

async function main() {
  const schema = dbSchema();
  const db = getPool();
  const info = await db.query(
    `SELECT current_database() AS db, current_user AS usr, version() AS v,
            (SELECT extversion FROM pg_extension WHERE extname = 'timescaledb') AS ts`,
  );
  const { db: name, usr, v, ts } = info.rows[0];
  console.log(`Connected: database "${name}" as "${usr}"`);
  console.log(`  ${v.split(',')[0]}`);
  console.log(`  TimescaleDB: ${ts ?? 'not installed'}`);
  console.log(`  Schema: "${schema}"`);

  const { counts, hypertable, migrations } = await inspectSchema(db, schema);
  console.log(
    `  Migrations applied: ${migrations.length ? migrations.join(', ') : 'none (run npm run db:migrate)'}`,
  );
  if (hypertable !== null) console.log(`  bank_transactions is a hypertable: ${hypertable ? 'yes' : 'NO'}`);
  console.log('  Rows:');
  for (const [t, n] of Object.entries(counts)) console.log(`    ${t.padEnd(18)} ${n ?? 'missing'}`);
}

main()
  .catch((err) => {
    console.error('DB check failed:', err.message);
    process.exitCode = 1;
  })
  .finally(closePool);
