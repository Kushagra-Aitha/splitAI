import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createApp } from '../app.js';
import { loadConfig } from '../config.js';
import { HttpError } from '../http.js';
import { routes } from '../routes.js';
import { createStaticFiles } from '../static.js';

const ACTOR_ID = '00000000-0000-4000-8000-000000000001';
const ACCESS_CODE = 'test-only-access-code-with-32-characters';
const ORIGIN = 'http://localhost:3001';
const env = {
  NODE_ENV: 'test', APP_ORIGIN: ORIGIN, DEMO_ACTOR_ID: ACTOR_ID, DEMO_ACCESS_CODE: ACCESS_CODE,
};

async function start(t, options = {}) {
  const server = createApp({ config: loadConfig(env), ...options });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    const closed = new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    server.closeAllConnections();
    await closed;
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return async (url, options) => fetch(base + url, options);
}

async function login(request, body = {}) {
  const response = await request('/api/session', {
    method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ accessCode: ACCESS_CODE, ...body }),
  });
  assert.equal(response.status, 200);
  return { cookie: response.headers.get('set-cookie').split(';', 1)[0], data: await response.json(), response };
}

function mutation(auth, body = {}) {
  return {
    method: 'POST',
    headers: { Origin: ORIGIN, Cookie: auth.cookie, 'X-CSRF-Token': auth.data.csrfToken, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

test('configuration fails closed for missing identity, credentials, and unsafe origins', () => {
  for (const invalid of [
    { DEMO_ACTOR_ID: undefined }, { DEMO_ACTOR_ID: 'not-a-uuid' },
    { DEMO_ACCESS_CODE: '' }, { DEMO_ACCESS_CODE: 'short' },
    { APP_ORIGIN: 'https://example.com/' }, { APP_ORIGIN: 'http://example.com' },
    { NODE_ENV: 'production', APP_ORIGIN: ORIGIN }, { PORT: '0' }, { PORT: 'not-a-port' },
  ]) assert.throws(() => loadConfig({ ...env, ...invalid }));
  assert.equal(loadConfig({ ...env, NODE_ENV: 'production', APP_ORIGIN: 'https://split.example' }).secureCookies, true);
});

test('health is public and does not disclose identity or configuration', async (t) => {
  const request = await start(t);
  const response = await request('/health');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok' });
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('x-request-id'), /^[a-f0-9-]{36}$/);
  const head = await request('/health', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  assert.equal((await request('/health', { method: 'POST' })).status, 405);
});

test('the app receives the configured actor; client identity and account fields cannot override it', async (t) => {
  let observed;
  const request = await start(t, {
    handlers: {
      'goals.create': async (context) => {
        observed = context;
        assert.equal(Object.isFrozen(context.actor), true);
        assert.equal(Object.isFrozen(context), true);
        return { actor: context.actor };
      },
    },
  });
  const spoof = { userId: 'attacker', payer: 'attacker', accountId: 'other-account', actor: { userId: 'attacker' } };
  const auth = await login(request, spoof);
  assert.deepEqual(auth.data.actor, { userId: ACTOR_ID, displayName: 'Maya Chen' });
  assert.match(auth.response.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  assert.equal(auth.response.headers.get('cache-control'), 'no-store');
  const current = await request('/api/session?userId=attacker', {
    headers: { Cookie: auth.cookie, 'X-User-Id': 'attacker', Authorization: 'Bearer attacker' },
  });
  assert.deepEqual((await current.json()).actor, auth.data.actor);
  const response = await request('/api/goals?userId=attacker', mutation(auth, spoof));
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).actor, auth.data.actor);
  assert.deepEqual(observed.body, spoof);
  assert.notEqual(observed.actor, observed.body.actor);
});

test('every feature route requires a session and remains an honest 501 placeholder', async (t) => {
  const request = await start(t);
  const auth = await login(request);
  for (const route of routes) {
    const pathname = route.path.replace(':id', ACTOR_ID);
    const unauthenticated = await request(pathname, route.method === 'GET' ? {} : mutation({ ...auth, cookie: 'split-session=forged' }));
    assert.equal(unauthenticated.status, 401, route.name);
    const response = await request(pathname, route.method === 'GET' ? { headers: { Cookie: auth.cookie } } : mutation(auth));
    assert.equal(response.status, 501, route.name);
    assert.equal((await response.json()).error.code, 'NOT_IMPLEMENTED');
  }
  assert.equal((await request('/api/no-such-feature')).status, 404);
  const wrongMethod = await request('/api/goals', { method: 'PATCH', headers: { Cookie: auth.cookie } });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get('allow'), 'GET, POST');
});

test('cross-origin, missing-origin, and forged-CSRF mutations never reach handlers', async (t) => {
  let calls = 0;
  const request = await start(t, { handlers: { 'goals.create': async () => { calls++; return {}; } } });
  const auth = await login(request);
  for (const replacement of [
    { Origin: undefined }, { Origin: 'https://attacker.example' },
    { 'X-CSRF-Token': undefined }, { 'X-CSRF-Token': 'forged' },
    { 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Site': 'same-site' },
  ]) {
    const options = mutation(auth);
    for (const [name, value] of Object.entries(replacement)) {
      if (value === undefined) delete options.headers[name];
      else options.headers[name] = value;
    }
    assert.equal((await request('/api/goals', options)).status, 403);
  }
  assert.equal(calls, 0);
  const crossOriginLogin = mutation(auth, { accessCode: ACCESS_CODE });
  crossOriginLogin.headers.Origin = 'https://attacker.example';
  const response = await request('/api/session', crossOriginLogin);
  assert.equal(response.status, 403);
  assert.equal(response.headers.get('access-control-allow-origin'), null);
});

test('expired, forged, and logged-out sessions fail; login rotates the cookie', async (t) => {
  let time = Date.now();
  const request = await start(t, { now: () => time });
  const auth = await login(request);
  const wrongCookie = auth.cookie.slice(0, -1) + (auth.cookie.endsWith('0') ? '1' : '0');
  assert.equal((await request('/api/session', { headers: { Cookie: wrongCookie } })).status, 401);
  const rotated = await request('/api/session', mutation(auth, { accessCode: ACCESS_CODE }));
  const cookie = rotated.headers.get('set-cookie').split(';', 1)[0];
  const data = await rotated.json();
  assert.notEqual(cookie, auth.cookie);
  assert.equal((await request('/api/session', { headers: { Cookie: auth.cookie } })).status, 401);
  const logout = await request('/api/session', { ...mutation({ cookie, data }), method: 'DELETE' });
  assert.equal(logout.status, 204);
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await request('/api/session', { headers: { Cookie: cookie } })).status, 401);
  const expiring = await login(request);
  time += 8 * 60 * 60 * 1000;
  assert.equal((await request('/api/session', { headers: { Cookie: expiring.cookie } })).status, 401);
});

test('HTTPS configuration uses a Secure host-only cookie independent of forwarded headers', async (t) => {
  const origin = 'https://split.example';
  const request = await start(t, { config: loadConfig({ ...env, NODE_ENV: 'production', APP_ORIGIN: origin }) });
  const response = await request('/api/session', {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Forwarded-Proto': 'http', 'X-User-Id': 'attacker' },
    body: JSON.stringify({ accessCode: ACCESS_CODE }),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('set-cookie'), /^__Host-split-session=.*; Path=\/; HttpOnly; SameSite=Strict; Max-Age=28800; Secure$/);
  assert.equal(response.headers.get('strict-transport-security'), 'max-age=31536000');
  assert.equal((await response.json()).actor.userId, ACTOR_ID);
});

test('malformed, non-object, non-JSON, and excessive bodies are rejected before a handler', async (t) => {
  const request = await start(t, { handlers: { 'goals.create': async () => assert.fail('must not run') } });
  const auth = await login(request);
  for (const body of ['{', 'null', '[]', '42']) {
    assert.equal((await request('/api/goals', { ...mutation(auth), body })).status, 422);
  }
  const notJson = mutation(auth);
  notJson.headers['Content-Type'] = 'text/plain';
  assert.equal((await request('/api/goals', notJson)).status, 415);
  assert.equal((await request('/api/goals', mutation(auth, { text: 'a'.repeat(17 * 1024) }))).status, 413);
  const streamed = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"text":"'));
      controller.enqueue(new TextEncoder().encode('a'.repeat(17 * 1024)));
      controller.enqueue(new TextEncoder().encode('"}'));
      controller.close();
    },
  });
  assert.equal((await request('/api/goals', { ...mutation(auth), body: streamed, duplex: 'half' })).status, 413);
});

test('login rate limits cannot be bypassed using spoofed forwarding headers', async (t) => {
  const request = await start(t);
  for (let i = 0; i < 10; i++) {
    const response = await request('/api/session', {
      method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json', 'X-Forwarded-For': `192.0.2.${i}` },
      body: JSON.stringify({ accessCode: 'wrong' }),
    });
    assert.equal(response.status, 401);
  }
  const response = await request('/api/session', {
    method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify({ accessCode: ACCESS_CODE }),
  });
  assert.equal(response.status, 429);
  assert.ok(Number(response.headers.get('retry-after')) > 0);
});

test('unexpected errors are redacted; expected scope and conflict responses remain explicit', async (t) => {
  const logs = [];
  let mode = 'unexpected';
  const request = await start(t, {
    onError: (event) => logs.push(event),
    handlers: { 'goals.list': async () => {
      if (mode === 'unexpected') throw new Error('secret-provider-key-and-private-prompt');
      throw new HttpError(mode === 'scope' ? 403 : 409, mode === 'scope' ? 'SCOPE_FORBIDDEN' : 'INSUFFICIENT_FUNDS', 'Safe message.');
    } },
  });
  const auth = await login(request);
  const response = await request('/api/goals', { headers: { Cookie: auth.cookie } });
  assert.equal(response.status, 500);
  const error = (await response.json()).error;
  assert.equal(error.code, 'INTERNAL_ERROR');
  assert.equal(JSON.stringify(error).includes('secret'), false);
  assert.deepEqual(logs, [{ requestId: error.requestId, code: 'INTERNAL_ERROR' }]);
  for (const [value, status] of [['scope', 403], ['funds', 409]]) {
    mode = value;
    assert.equal((await request('/api/goals', { headers: { Cookie: auth.cookie } })).status, status);
  }
});

test('one origin serves the app and API, but never secrets, source maps, or symlink escapes', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'split-f3-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const dist = path.join(directory, 'dist');
  await mkdir(path.join(dist, 'assets'), { recursive: true });
  const html = '<!doctype html><script>document.documentElement.dataset.theme="light";</script><script src="/assets/app.js"></script>';
  await writeFile(path.join(dist, 'index.html'), html);
  await writeFile(path.join(dist, 'assets', 'app.js'), 'console.log("app")');
  await writeFile(path.join(dist, 'assets', 'app.js.map'), 'private source');
  await writeFile(path.join(dist, '.env'), 'secret');
  await writeFile(path.join(directory, 'private.js'), 'secret');
  await symlink(path.join(directory, 'private.js'), path.join(dist, 'escape.js'));
  const serveStatic = await createStaticFiles(dist);
  const request = await start(t, { serveStatic });
  const response = await request('/');
  assert.equal(response.status, 200);
  assert.equal(await response.text(), html);
  assert.match(response.headers.get('content-security-policy'), /script-src 'self' 'sha256-/);
  assert.equal(response.headers.get('content-security-policy').includes("script-src 'self' 'unsafe-inline'"), false);
  const asset = await request('/assets/app.js');
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get('cache-control'), /immutable/);
  assert.equal((await request('/health')).status, 200);
  assert.equal((await request('/api/session')).status, 401);
  const head = await request('/', { method: 'HEAD' });
  assert.equal(await head.text(), '');
  assert.ok(Number(head.headers.get('content-length')) > 0);
  for (const pathname of ['/.env', '/%2eenv', '/assets/app.js.map', '/escape.js', '/assets/%2e%2e%2f%2e%2e%2fprivate.js', '/missing.js']) {
    assert.equal((await request(pathname)).status, 404, pathname);
  }
});
