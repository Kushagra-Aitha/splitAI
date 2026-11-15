export const TABLES = [
  'users', 'bank_accounts', 'bank_transactions', 'bank_import_keys', 'groups',
  'group_members', 'expenses', 'expense_shares', 'settlements', 'guard_events',
  'goals', 'goal_movements', 'bill_schedules',
];

/** Row counts per base table (null = missing), hypertable status, migrations. */
export async function inspectSchema(db, schema) {
  const present = await db.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = $1`,
    [schema],
  );
  const names = new Set(present.rows.map((r) => r.table_name));
  const counts = {};
  for (const t of TABLES) {
    counts[t] = names.has(t)
      ? (await db.query(`SELECT count(*)::int AS n FROM "${schema}"."${t}"`)).rows[0].n
      : null;
  }
  let hypertable = null;
  const ts = await db.query(`SELECT 1 FROM pg_extension WHERE extname = 'timescaledb'`);
  if (ts.rowCount && names.has('bank_transactions')) {
    const h = await db.query(
      `SELECT 1 FROM timescaledb_information.hypertables
       WHERE hypertable_schema = $1 AND hypertable_name = 'bank_transactions'`,
      [schema],
    );
    hypertable = h.rowCount > 0;
  }
  const migrations = names.has('schema_migrations')
    ? (await db.query(`SELECT filename FROM "${schema}".schema_migrations ORDER BY filename`)).rows.map(
        (r) => r.filename,
      )
    : [];
  return { counts, hypertable, migrations };
}
