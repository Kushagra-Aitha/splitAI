import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { isMain } from '../lib/is-main.js';
import { closePool, dbSchema, getPool } from './pool.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations/', import.meta.url));
const FILE_NAME = /^\d{4}_[a-z0-9_]+\.sql$/;

/**
 * Applies every pending server/db/migrations/NNNN_name.sql file to DB_SCHEMA,
 * in filename order, each in its own transaction. Safe to run repeatedly and
 * concurrently: applied files are skipped, and an advisory lock serializes
 * runners on the same schema. An applied file whose contents changed is an
 * error. Add a new migration instead of editing one.
 */
export async function migrate({ log = console.log } = {}) {
  const schema = dbSchema();
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  const badNames = files.filter((f) => !FILE_NAME.test(f));
  if (badNames.length) throw new Error(`Bad migration file name(s): ${badNames.join(', ')}`);

  const client = await getPool().connect();
  try {
    await client.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    await client.query(`SET search_path TO "${schema}", public`);
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [`split:migrate:${schema}`]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename    text PRIMARY KEY,
        checksum    text NOT NULL,
        applied_at  timestamptz NOT NULL DEFAULT now()
      )`);
    const { rows } = await client.query('SELECT filename, checksum FROM schema_migrations');
    const applied = new Map(rows.map((r) => [r.filename, r.checksum]));

    let count = 0;
    for (const file of files) {
      const sql = await readFile(MIGRATIONS_DIR + file, 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      if (applied.has(file)) {
        if (applied.get(file) !== checksum) {
          throw new Error(
            `${file} changed after it was applied to schema "${schema}". ` +
              'Add a new migration instead (or drop the schema in a personal sandbox).',
          );
        }
        continue;
      }
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)', [
          file,
          checksum,
        ]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        err.message = `${file}: ${err.message}`;
        throw err;
      }
      log(`  applied ${file}`);
      count++;
    }
    log(
      count
        ? `Migrated schema "${schema}": ${count} file(s) applied.`
        : `Schema "${schema}" is up to date.`,
    );
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', [`split:migrate:${schema}`]).catch(() => {});
    client.release();
  }
}

if (isMain(import.meta.url)) {
  migrate()
    .catch((err) => {
      console.error('Migration failed:', err.message);
      process.exitCode = 1;
    })
    .finally(closePool);
}
