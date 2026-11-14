// B8 · Email/password accounts through the real HTTP boundary (memory store).
import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { createApp } from '../app.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { createMemoryAuthStore } from '../auth/store.js';
import { loadConfig } from '../config.js';
import { initialsFor, normalizeEmail } from '../session.js';

const ORIGIN = 'http://localhost:3001';
const json = { Origin: ORIGIN, 'Content-Type': 'application/json' };

async function start(t, authStore = createMemoryAuthStore()) {
  const server = createApp({
    config: loadConfig({ NODE_ENV: 'test', APP_ORIGIN: ORIGIN }),
    authStore,
    handlers: { 'goals.list': async ({ actor }) => ({ actor }) },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    const closed = new Promise((resolve) => server.close(resolve));
    server.closeAllConnections();
    await closed;
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (path, body, headers = {}) => {
    const response = await fetch(base + path, { method: 'POST', headers: { ...json, ...headers }, body: JSON.stringify(body) });
    const text = await response.text();
    return { status: response.status, headers: response.headers, data: text ? JSON.parse(text) : null,
      cookie: response.headers.get('set-cookie')?.split(';', 1)[0] ?? null };
  };
  const get = async (path, cookie) => {
    const response = await fetch(base + path, { headers: cookie ? { Cookie: cookie } : {} });
    return { status: response.status, data: await response.json() };
  };
  return { post, get, authStore };
}

test('passwords are salted scrypt hashes; verification is exact and Unicode-normalized', async () => {
  const hash = await hashPassword('correct horse battery');
  assert.match(hash, /^scrypt\$16384\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
  assert.equal(hash.includes('correct horse'), false);
  assert.notEqual(hash, await hashPassword('correct horse battery'));
  assert.equal(await verifyPassword('correct horse battery', hash), true);
  assert.equal(await verifyPassword('correct horse batterY', hash), false);
  assert.equal(await verifyPassword('café-password', await hashPassword('café-password')), true);
  for (const broken of [null, '', 'plain', 'scrypt$1$8$1$AA==$AA==', 'bcrypt$x$y$z$a$b']) {
    assert.equal(await verifyPassword('anything', broken), false);
  }
  assert.equal(normalizeEmail('  Maya@Split.TEST '), 'maya@split.test');
  for (const bad of ['', 'maya', 'maya@split', 'a b@c.d', `${'a'.repeat(250)}@x.io`, 42]) assert.equal(normalizeEmail(bad), null);
  assert.equal(initialsFor('Maya Chen'), 'MC');
  assert.equal(initialsFor('Priya'), 'P');
  assert.equal(initialsFor('Ana de la Cruz'), 'AC');
});

test('sign up, log out, and log back in; identity comes only from the account', async (t) => {
  const { post, get } = await start(t);
  const signup = await post('/api/auth/signup', {
    name: '  Jordan   Lee ', email: 'Jordan@Example.COM', password: 'a-good-password',
    userId: 'attacker', actor: { userId: 'attacker' },
  });
  assert.equal(signup.status, 200);
  assert.equal(signup.data.actor.displayName, 'Jordan Lee');
  assert.match(signup.data.actor.userId, /^[0-9a-f-]{36}$/);
  assert.match(signup.data.csrfToken, /^[a-f0-9]{64}$/);
  assert.match(signup.headers.get('set-cookie'), /HttpOnly; SameSite=Strict; Max-Age=604800/);
  assert.deepEqual((await get('/api/session', signup.cookie)).data.actor, signup.data.actor);

  const logout = await post('/api/auth/logout', {}, { Cookie: signup.cookie, 'X-CSRF-Token': signup.data.csrfToken });
  assert.equal(logout.status, 204);
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await get('/api/session', signup.cookie)).status, 401);

  const login = await post('/api/auth/login', { email: 'jordan@example.com', password: 'a-good-password' });
  assert.equal(login.status, 200);
  assert.deepEqual(login.data.actor, signup.data.actor);
  assert.notEqual(login.cookie, signup.cookie);
});

test('sign-up validates input and refuses a second account for the same email', async (t) => {
  const { post } = await start(t);
  for (const [body, message] of [
    [{ name: '', email: 'a@b.co', password: 'long-enough' }, /name/],
    [{ name: 'x'.repeat(81), email: 'a@b.co', password: 'long-enough' }, /name/],
    [{ name: 'Ok\u0007', email: 'a@b.co', password: 'long-enough' }, /name/],
    [{ name: 'Ok', email: 'not-an-email', password: 'long-enough' }, /email/],
    [{ name: 'Ok', email: 'a@b.co', password: 'short' }, /at least 8/],
    [{ name: 'Ok', email: 'a@b.co', password: 'p'.repeat(257) }, /too long/],
    [{ name: 'Ok', email: 'a@b.co', password: 12345678 }, /at least 8/],
  ]) {
    const response = await post('/api/auth/signup', body);
    assert.equal(response.status, 422, JSON.stringify(body).slice(0, 60));
    assert.match(response.data.error.message, message);
  }
  assert.equal((await post('/api/auth/signup', { name: 'Sam', email: 'sam@split.test', password: 'first-password' })).status, 200);
  const again = await post('/api/auth/signup', { name: 'Other Sam', email: 'SAM@split.test', password: 'second-password' });
  assert.equal(again.status, 409);
  assert.equal(again.data.error.code, 'EMAIL_TAKEN');
  assert.equal((await post('/api/auth/login', { email: 'sam@split.test', password: 'second-password' })).status, 401);
});

test('a wrong password and an unknown email fail identically', async (t) => {
  const store = createMemoryAuthStore();
  await store.addUser({ email: 'maya@split.test', displayName: 'Maya Chen', password: 'maya-password' });
  const { post } = await start(t, store);
  const wrong = await post('/api/auth/login', { email: 'maya@split.test', password: 'not-her-password' });
  const unknown = await post('/api/auth/login', { email: 'nobody@split.test', password: 'not-her-password' });
  const malformed = await post('/api/auth/login', { email: 'nope', password: ['x'] });
  for (const response of [wrong, unknown, malformed]) {
    assert.equal(response.status, 401);
    assert.equal(response.data.error.code, 'INVALID_CREDENTIALS');
    assert.equal(response.data.error.message, 'That email and password don’t match.');
    assert.equal(response.cookie, null);
  }
});

test('repeated wrong passwords lock that email for a while without locking others', async (t) => {
  let time = Date.now();
  const store = createMemoryAuthStore();
  await store.addUser({ email: 'maya@split.test', displayName: 'Maya', password: 'maya-password' });
  await store.addUser({ email: 'sam@split.test', displayName: 'Sam', password: 'sam-password' });
  const server = createApp({ config: loadConfig({ NODE_ENV: 'test', APP_ORIGIN: ORIGIN }), authStore: store, now: () => time });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { const closed = once(server, 'close'); server.close(); server.closeAllConnections(); await closed; });
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = (email, password) => fetch(`${base}/api/auth/login`, { method: 'POST', headers: json, body: JSON.stringify({ email, password }) });
  for (let i = 0; i < 5; i++) assert.equal((await login('maya@split.test', 'wrong-guess')).status, 401);
  const locked = await login('maya@split.test', 'maya-password');
  assert.equal(locked.status, 429);
  assert.ok(Number(locked.headers.get('retry-after')) > 0);
  assert.equal((await login('sam@split.test', 'sam-password')).status, 200);
  time += 15 * 60_000 + 1;
  assert.equal((await login('maya@split.test', 'maya-password')).status, 200);
});

test('two users signed in at once only ever act as themselves', async (t) => {
  const { post, get } = await start(t);
  const maya = await post('/api/auth/signup', { name: 'Maya Chen', email: 'maya@split.test', password: 'maya-password' });
  const sam = await post('/api/auth/signup', { name: 'Sam Lee', email: 'sam@split.test', password: 'sam-password' });
  assert.notEqual(maya.data.actor.userId, sam.data.actor.userId);
  assert.deepEqual((await get('/api/goals', maya.cookie)).data.actor, maya.data.actor);
  assert.deepEqual((await get('/api/goals', sam.cookie)).data.actor, sam.data.actor);
  // Sam's CSRF token cannot authorize a write on Maya's session.
  const crossed = await post('/api/auth/logout', {}, { Cookie: maya.cookie, 'X-CSRF-Token': sam.data.csrfToken });
  assert.equal(crossed.status, 403);
  assert.equal((await get('/api/session', maya.cookie)).status, 200);
});

test('sessions live in the store, so a restarted server keeps people signed in', async (t) => {
  const store = createMemoryAuthStore();
  const first = await start(t, store);
  const signup = await first.post('/api/auth/signup', { name: 'Priya', email: 'priya@split.test', password: 'priya-password' });
  const second = await start(t, store);
  assert.deepEqual((await second.get('/api/session', signup.cookie)).data.actor, signup.data.actor);
});

test('only the documented auth routes and methods exist', async (t) => {
  const { post, get } = await start(t);
  assert.equal((await post('/api/session', { accessCode: 'anything' })).status, 405);
  assert.equal((await post('/api/auth/reset', {})).status, 404);
  assert.equal((await get('/api/auth/login')).status, 405);
  assert.equal((await post('/api/auth/login', {}, { Origin: 'https://attacker.example' })).status, 403);
  const anonymousLogout = await post('/api/auth/logout', {});
  assert.equal(anonymousLogout.status, 204);
  assert.equal((await get('/api/session')).status, 401);
});
