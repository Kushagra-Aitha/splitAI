// B8 · Live Tiger Data check for accounts and sessions. Opt in with
// RUN_AUTH_DB_TESTS=1. Uses a fresh throwaway schema and drops it afterwards;
// never touches the configured working or shared schema.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import test from 'node:test';

test('live database: sign-up stores a hashed password and hashed session token that survive a restart', {
  skip: process.env.RUN_AUTH_DB_TESTS !== '1',
}, async (t) => {
  await import('../lib/env.js');
  const schema = `split_b_auth_${randomUUID().replaceAll('-', '')}`;
  process.env.DB_SCHEMA = schema;
  const { getPool, closePool } = await import('../db/pool.js');
  const { migrate } = await import('../db/migrate.js');
  const { createApp } = await import('../app.js');
  const { createDbAuthStore } = await import('../auth/store.js');
  const { loadConfig } = await import('../config.js');
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

  const origin = 'http://localhost:3001';
  const authStore = createDbAuthStore({ query: (...args) => db.query(...args) });
  const startServer = async () => {
    const server = createApp({ config: loadConfig({ NODE_ENV: 'test', APP_ORIGIN: origin }), authStore });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(async () => { const closed = once(server, 'close'); server.close(); server.closeAllConnections(); await closed; });
    return `http://127.0.0.1:${server.address().port}`;
  };
  const post = (base, path, body, headers = {}) => fetch(base + path, {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  });

  const base = await startServer();
  const signup = await post(base, '/api/auth/signup', { name: 'Jordan Lee', email: 'Jordan@Example.com', password: 'jordan-password' });
  assert.equal(signup.status, 200);
  const session = await signup.json();
  const cookie = signup.headers.get('set-cookie').split(';', 1)[0];
  const token = cookie.split('=')[1];

  const { rows: [user] } = await db.query('SELECT email, password_hash, display_name, full_name, initials FROM users WHERE id = $1', [session.actor.userId]);
  assert.deepEqual({ email: user.email, display: user.display_name, full: user.full_name, initials: user.initials },
    { email: 'jordan@example.com', display: 'Jordan', full: 'Jordan Lee', initials: 'JL' });
  assert.match(user.password_hash, /^scrypt\$/);
  assert.equal(user.password_hash.includes('jordan-password'), false);

  const { rows: sessions } = await db.query('SELECT token_hash, csrf_token FROM sessions WHERE user_id = $1', [session.actor.userId]);
  assert.equal(sessions.length, 1);
  assert.deepEqual(sessions[0].token_hash, createHash('sha256').update(token).digest());
  assert.equal(JSON.stringify(sessions).includes(token), false);

  assert.equal((await post(base, '/api/auth/signup', { name: 'Again', email: 'jordan@example.com', password: 'other-password' })).status, 409);
  await assert.rejects(db.query(`INSERT INTO users (handle, display_name, initials, email) VALUES ('x', 'X', 'X', 'Upper@Case.com')`), /users_email_lowercase/);

  // A second server process (same database) still recognizes the cookie.
  const restarted = await startServer();
  const current = await fetch(`${restarted}/api/session`, { headers: { Cookie: cookie } });
  assert.equal(current.status, 200);
  assert.deepEqual((await current.json()).actor, session.actor);

  const logout = await post(restarted, '/api/auth/logout', {}, { Cookie: cookie, 'X-CSRF-Token': session.csrfToken });
  assert.equal(logout.status, 204);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM sessions')).rows[0].n, 0);
  assert.equal((await post(base, '/api/auth/login', { email: 'jordan@example.com', password: 'wrong-password' })).status, 401);
  assert.equal((await post(base, '/api/auth/login', { email: 'JORDAN@example.com', password: 'jordan-password' })).status, 200);
});
