import pg from 'pg';
import { optionalEnv, requireEnv } from '../lib/env.js';

// node-postgres returns bigint (int8) as a string by default. Cents in this
// app stay far below 2^53, so parse them as numbers once, here.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));

const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

export function dbSchema() {
  const schema = optionalEnv('DB_SCHEMA') || 'split';
  if (!SCHEMA_NAME.test(schema)) {
    throw new Error(`DB_SCHEMA "${schema}" must be lowercase letters, digits or underscores.`);
  }
  return schema;
}

// A pg.Client that sets the search path as part of connecting, so the pool
// never hands out a connection before it points at DB_SCHEMA.
function schemaClient(schema) {
  return class SchemaClient extends pg.Client {
    connect(callback) {
      const ready = super
        .connect()
        .then(() => super.query(`SET search_path TO "${schema}", public`))
        .then(() => undefined);
      if (!callback) return ready;
      ready.then(() => callback(null), callback);
    }
  };
}

function connectionConfig(schema) {
  const url = new URL(requireEnv('DATABASE_URL'));
  // TLS is configured explicitly below; drop sslmode so pg does not
  // reinterpret it.
  url.searchParams.delete('sslmode');
  const sslOff = optionalEnv('DB_SSL') === 'false';
  return {
    connectionString: url.toString(),
    ssl: sslOff ? false : { rejectUnauthorized: optionalEnv('DB_SSL_VERIFY') !== 'false' },
    Client: schemaClient(schema),
    max: Number(optionalEnv('DB_POOL_MAX') || 10),
    connectionTimeoutMillis: 10_000,
    application_name: 'split-ai',
  };
}

let pool;

/**
 * Shared pool. Every connection uses `<DB_SCHEMA>, public` as its search
 * path, so queries use unqualified table names and TimescaleDB functions
 * (installed in public) still resolve.
 */
export function getPool() {
  if (!pool) {
    pool = new pg.Pool(connectionConfig(dbSchema()));
    pool.on('error', (err) => console.error('[db] idle client error:', err.message));
  }
  return pool;
}

/** Runs fn(client) inside one transaction, rolling back on any error. */
export async function withTransaction(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool() {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}
