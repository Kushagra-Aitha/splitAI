import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import test from 'node:test';
import { createApp } from '../app.js';
import { loadConfig } from '../config.js';
import { getMappedAccountForUser } from '../banking/provider.js';
import { accountIdForUser } from '../banking/overview.js';
import { createCapitalService } from '../capital-two/service.js';
import { createCapitalHandlers } from '../capital-two/handlers.js';
import { fakeCapitalProvider } from './support/capital-provider.js';
import { loginAs, memoryAuth } from './support/auth.js';

test('live database: Capital Two owns accounts, charges once and persists scheduled payments', {
  skip: process.env.RUN_CAPITAL_DB_TESTS !== '1',
}, async (t) => {
  const schema = `split_c_bank_${randomUUID().replaceAll('-', '')}`;
  process.env.DB_SCHEMA = schema;
  const { getPool, withTransaction, closePool } = await import('../db/pool.js');
  const { migrate } = await import('../db/migrate.js');
  const db = getPool(); let owned = false;
  t.after(async () => { try { if (owned) await db.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await closePool(); } });
  await db.query(`CREATE SCHEMA "${schema}"`); owned = true; await migrate({ log: () => {} });
  const users = [randomUUID(), randomUUID()];
  for (let i = 0; i < users.length; i++) await db.query(`INSERT INTO users
    (id, handle, display_name, initials, email) VALUES ($1, $2, $2, 'CT', $3)`, [users[i], `capital-${i}`, `capital${i}@split.test`]);
  const query = (...args) => db.query(...args), provider = fakeCapitalProvider();
  let clock = new Date('2026-11-14T17:00:00Z');
  const dependencies = { query, withTransaction, nessie: provider.request, now: () => clock };
  const service = createCapitalService(dependencies);
  let checking, card;
  const payment = (extra = {}) => ({ accountId: card.id, kind: 'purchase', payee: "Domino's", amountCents: 2400, requestKey: randomUUID(), ...extra });

  await t.test('checking/card provision once across concurrent connections and checking remains the funds account', async () => {
    await Promise.all([service.connect(users[0]), service.connect(users[0])]);
    const summary = await service.summary(users[0]);
    assert.equal(summary.accounts.length, 2);
    checking = summary.accounts.find((account) => account.type === 'Checking');
    card = summary.accounts.find((account) => account.type === 'Credit Card');
    assert.equal(checking.balanceCents, 150000); assert.equal(card.balanceCents, 0); assert.equal(card.creditLimitCents, 500000);
    await service.connect(users[0]); assert.equal(provider.accounts.size, 2);
    assert.equal((await getMappedAccountForUser(db, users[0])).id, checking.id);
    assert.equal(await accountIdForUser(db, users[0]), checking.id);
    assert.ok(!JSON.stringify(summary.accounts).includes('provider_account_id'));
  });

  await t.test('concurrent purchase retries charge once, update card debt and preserve checking', async () => {
    const body = payment(); const before = provider.createCalls;
    const results = await Promise.all([1, 2, 3].map(() => service.operations.create(users[0], body)));
    assert.equal(new Set(results.map((result) => result.id)).size, 1);
    assert.equal(provider.createCalls, before + 1);
    assert.equal((await service.operations.create(users[0], body)).status, 'completed');
    const summary = await service.sync(users[0]);
    assert.equal(summary.accounts.find((account) => account.id === card.id).balanceCents, 2400);
    assert.equal(summary.accounts.find((account) => account.id === checking.id).balanceCents, 150000);
    assert.equal(summary.transactions.filter((transaction) => transaction.kind === 'purchase').length, 1);
    assert.ok(!summary.transactions[0].description.includes(results[0].id));
    await assert.rejects(service.operations.create(users[0], { ...body, amountCents: 2500 }), (error) => error.code === 'BANK_KEY_REUSED');
  });

  await t.test('paying the card is one transfer, with no second purchase/spending row', async () => {
    const body = payment({ accountId: checking.id, kind: 'card_payment', amountCents: 2400 });
    assert.equal((await service.operations.create(users[0], body)).status, 'completed');
    const summary = await service.sync(users[0]);
    assert.equal(summary.accounts.find((account) => account.id === card.id).balanceCents, 0);
    assert.equal(summary.accounts.find((account) => account.id === checking.id).balanceCents, 147600);
    assert.equal(summary.transactions.filter((transaction) => transaction.kind === 'purchase').length, 1);
    const transfers = summary.transactions.filter((transaction) => transaction.kind === 'transfer');
    assert.deepEqual(transfers.map((transaction) => transaction.direction).sort(), ['credit', 'debit']);
    await assert.rejects(service.operations.create(users[0], payment({ kind: 'card_payment' })), (error) => error.status === 422);
  });

  await t.test('lost create responses recover by immutable reference instead of charging again', async () => {
    const body = payment(); const before = provider.createCalls;
    provider.loseCreateResponse();
    const unknown = await service.operations.create(users[0], body);
    assert.equal(unknown.status, 'unknown');
    assert.equal((await service.operations.create(users[0], body)).status, 'completed');
    assert.equal(provider.createCalls, before + 1);
    assert.equal((await db.query('SELECT id FROM capital_operations WHERE request_key = $1', [body.requestKey])).rowCount, 1);
  });

  await t.test('a crash while recording provider acknowledgement recovers the original transaction after restart', async () => {
    const body = payment(); const before = provider.createCalls; let fail = true;
    const flaky = createCapitalService({ ...dependencies, query: async (...args) => {
      if (fail && args[0].includes('SET provider_reference = $3')) { fail = false; throw new Error('Synthetic database failure'); }
      return query(...args);
    } });
    await assert.rejects(flaky.operations.create(users[0], body), /Synthetic database failure/);
    await db.query("UPDATE capital_operations SET claimed_at = clock_timestamp() - interval '31 seconds' WHERE request_key = $1", [body.requestKey]);
    const restarted = createCapitalService(dependencies);
    assert.equal((await restarted.operations.create(users[0], body)).status, 'completed');
    assert.equal(provider.createCalls, before + 1);
  });

  await t.test('settlement timeouts reuse the provider ID; definitive rejection is not resent', async () => {
    const body = payment(); const before = provider.createCalls;
    provider.failSettlement(true);
    assert.equal((await service.operations.create(users[0], body)).status, 'pending');
    provider.failSettlement(false);
    assert.equal((await service.operations.create(users[0], body)).status, 'completed');
    assert.equal(provider.createCalls, before + 1);
    const rejected = payment({ amountCents: 100000000 });
    assert.equal((await service.operations.create(users[0], rejected)).status, 'declined');
    const calls = provider.createCalls;
    assert.equal((await service.operations.create(users[0], rejected)).status, 'declined'); assert.equal(provider.createCalls, calls);
  });

  await t.test('monthly run-now is repeat-safe; pause/delete stop future unsent occurrences', async () => {
    const body = { accountId: checking.id, payee: 'Rent', amountCents: 5000, dayOfMonth: 20, requestKey: randomUUID() };
    const schedule = await service.schedules.create(users[0], body);
    assert.deepEqual(await service.schedules.create(users[0], body), schedule);
    const before = provider.createCalls;
    const runs = await Promise.all([1, 2, 3].map(() => service.schedules.run(users[0], schedule.id, {})));
    assert.equal(new Set(runs.map((operation) => operation.id)).size, 1); assert.equal(provider.createCalls, before + 1);
    assert.equal((await service.summary(users[0])).schedules.find((row) => row.id === schedule.id).nextDueOn, '2026-12-20');
    await service.schedules.update(users[0], schedule.id, { action: 'pause' });
    await assert.rejects(service.schedules.run(users[0], schedule.id, {}), (error) => error.code === 'BANK_SCHEDULE_INACTIVE');
    clock = new Date('2026-12-21T17:00:00Z'); await service.tick(); assert.equal(provider.createCalls, before + 1);
    await service.schedules.update(users[0], schedule.id, { action: 'resume' });
    await service.schedules.update(users[0], schedule.id, { action: 'delete' });
    assert.ok(!(await service.summary(users[0])).schedules.some((row) => row.id === schedule.id));
  });

  await t.test('a restarted scheduler pays a dated operation once and clamped monthly dates persist', async () => {
    const schedule = await service.schedules.create(users[0], { accountId: checking.id, payee: 'Utilities', amountCents: 800,
      dueOn: '2026-12-22', requestKey: randomUUID() });
    const before = provider.createCalls;
    clock = new Date('2026-12-22T17:00:00Z');
    await Promise.all([service.tick(), createCapitalService(dependencies).tick()]); await service.tick();
    assert.equal(provider.createCalls, before + 1);
    assert.equal((await service.schedules.run(users[0], schedule.id, {})).status, 'completed');
    assert.equal(provider.createCalls, before + 1);
    clock = new Date('2027-02-01T17:00:00Z');
    const monthly = await service.schedules.create(users[0], { accountId: card.id, payee: 'Subscription', amountCents: 500,
      dayOfMonth: 31, requestKey: randomUUID() });
    assert.equal(monthly.nextDueOn, '2027-02-28');
  });

  await t.test('real sessions/CSRF and ownership checks prevent cross-user bank access and writes', async () => {
    await service.connect(users[1]);
    await assert.rejects(service.operations.create(users[1], payment()), (error) => error.status === 404);
    const operation = (await service.summary(users[0])).operations[0];
    await assert.rejects(service.operations.get(operation.id, users[1]), (error) => error.status === 404);
    const origin = 'http://localhost:3001';
    const authStore = await memoryAuth(users.map((userId, i) => ({ userId, email: `capital${i}@split.test`, displayName: `Capital ${i}` })));
    const server = createApp({ config: loadConfig({ NODE_ENV: 'test', APP_ORIGIN: origin }), authStore, handlers: createCapitalHandlers(service) });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(async () => { const closed = once(server, 'close'); server.close(); server.closeAllConnections(); await closed; });
    const base = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await fetch(`${base}/api/bank`)).status, 401);
    const login = await loginAs(base, origin, 'capital0@split.test'); assert.equal(login.status, 200);
    const response = await fetch(`${base}/api/bank`, { headers: { Cookie: login.cookie } });
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((await response.json()).accounts.length, 2);
    const send = (body, csrf = login.session.csrfToken) => fetch(`${base}/api/bank/operations`, { method: 'POST', headers: {
      Origin: origin, Cookie: login.cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf,
    }, body: JSON.stringify(body) });
    const before = provider.createCalls;
    assert.equal((await send(payment(), 'forged')).status, 403);
    assert.equal((await send(payment({ userId: users[1] }))).status, 422);
    assert.equal(provider.createCalls, before);
  });
});
