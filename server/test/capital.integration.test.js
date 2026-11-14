import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import test from 'node:test';
import { createApp } from '../app.js';
import { loadConfig } from '../config.js';
import { getMappedAccountForUser } from '../banking/provider.js';
import { accountIdForUser } from '../banking/overview.js';
import { linkBankAccounts, CARD_LIMIT_CENTS } from '../banking/provision.js';
import { createCapitalService } from '../capital-two/service.js';
import { createCapitalHandlers } from '../capital-two/handlers.js';
import { listTransactions } from '../banking/transactions.js';
import { createLedgerHandlers } from '../ledger/handlers.js';
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
  const payment = (extra = {}) => ({ accountId: card.id, kind: 'purchase', payee: "Domino's", category: 'Food & drink', amountCents: 2400, requestKey: randomUUID(), ...extra });

  await t.test('checking/card provision once across concurrent connections and checking remains the funds account', async () => {
    await Promise.all([service.connect(users[0]), service.connect(users[0])]);
    const summary = await service.summary(users[0]);
    assert.equal(summary.accounts.length, 2);
    checking = summary.accounts.find((account) => account.type === 'Checking');
    card = summary.accounts.find((account) => account.type === 'Credit Card');
    assert.equal(checking.balanceCents, 150000); assert.equal(card.balanceCents, 0); assert.equal(card.creditLimitCents, CARD_LIMIT_CENTS);
    await service.connect(users[0]); assert.equal(provider.accounts.size, 2);
    assert.equal(await getMappedAccountForUser(db, users[0]), null);
    assert.equal(await accountIdForUser(db, users[0]), null);
    assert.ok(summary.accounts.every((account) => !account.sharedWithSplit));
    await linkBankAccounts(db, users[0]);
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
    assert.equal(summary.transactions.find((transaction) => transaction.kind === 'purchase').category, 'Food & drink');
    assert.ok(summary.presets.every((preset) => !Object.hasOwn(preset, 'amountCents')));
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
    const flaky = createCapitalService({ ...dependencies, withTransaction: (fn) => withTransaction((client) => fn({
      query: (...args) => {
        if (fail && args[0].includes('SET provider_reference = $3')) { fail = false; throw new Error('Synthetic database failure'); }
        return client.query(...args);
      },
    })) });
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

  await t.test('a pending receipt can be split immediately without sync and remains one purchase after posting', async () => {
    const body = payment(), before = provider.createCalls;
    provider.failSettlement(true);
    const operation = await service.operations.create(users[0], body);
    assert.equal(operation.status, 'pending'); assert.ok(operation.transactionId); assert.equal(operation.sharedWithSplit, true);
    const filter = new URLSearchParams({ id: operation.transactionId });
    const { transactions } = await listTransactions(db, users[0], filter);
    assert.equal(transactions.length, 1); assert.equal(transactions[0].status, 'pending');
    assert.equal((await listTransactions(db, users[1], filter)).transactions.length, 0);
    await db.query('UPDATE bank_accounts SET linked_at = NULL WHERE id = $1', [card.id]);
    assert.equal((await listTransactions(db, users[0], filter)).transactions.length, 0);
    await linkBankAccounts(db, users[0]);
    const ledger = createLedgerHandlers({ query, withTransaction }), actor = { userId: users[0] };
    const { group } = await ledger['groups.create']({ actor, body: { name: 'Instant demo', kind: 'roommates', memberEmails: ['capital1@split.test'] } });
    const { draft } = await ledger['expenseDrafts.create']({ actor, body: {
      groupId: group.id, merchant: body.payee, cents: body.amountCents, participantIds: users,
      bankRef: { accountId: card.id, providerKey: transactions[0].providerKey },
    } });
    await ledger['expenseDrafts.confirm']({ actor, params: { id: draft.id } });
    await ledger['expenseDrafts.confirm']({ actor, params: { id: draft.id } });
    assert.equal((await db.query("SELECT id FROM expenses WHERE id = $1 AND status = 'confirmed'", [draft.id])).rowCount, 1);
    provider.failSettlement(false);
    const posted = await service.operations.create(users[0], body);
    assert.equal(posted.status, 'completed'); assert.equal(posted.transactionId, operation.transactionId);
    assert.equal(provider.createCalls, before + 1);
    assert.equal((await listTransactions(db, users[0], filter)).transactions[0].status, 'completed');
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

  await t.test('salary Run now, scheduler races and lost acknowledgements create one credit per anchored period', async () => {
    const body = { accountId: checking.id, kind: 'salary', payee: 'Demo employer', amountCents: 50000,
      frequency: 'biweekly', dueOn: '2027-02-05', requestKey: randomUUID() };
    const schedule = await service.schedules.create(users[0], body);
    const before = provider.createCalls;
    provider.loseCreateResponse();
    const first = await service.schedules.run(users[0], schedule.id, {});
    assert.equal(first.status, 'unknown');
    const results = await Promise.all([service.schedules.run(users[0], schedule.id, {}), service.schedules.run(users[0], schedule.id, {})]);
    assert.ok(results.every((op) => op.id === first.id));
    assert.equal(provider.createCalls, before + 1);
    const recovered = await service.schedules.run(users[0], schedule.id, {});
    assert.equal(recovered.status, 'completed'); assert.equal(recovered.kind, 'deposit');
    assert.ok([...provider.transactions.values()].some((tx) => tx.kind === 'deposit' && tx.description.startsWith('Payroll · Demo employer [')));
    const summary = await service.sync(users[0]);
    const salary = summary.transactions.find((tx) => tx.id === recovered.transactionId);
    assert.equal(salary.direction, 'credit'); assert.equal(salary.category, 'Salary'); assert.equal(salary.isSalary, true);
    assert.equal(summary.schedules.find((s) => s.id === schedule.id).nextDueOn, '2027-02-19');
    assert.equal((await service.schedules.create(users[0], body)).id, schedule.id);
    await assert.rejects(service.schedules.create(users[0], { ...body, frequency: 'monthly' }), (e) => e.code === 'BANK_KEY_REUSED');
    await assert.rejects(service.schedules.create(users[0], { ...body, accountId: card.id, requestKey: randomUUID() }), (e) => e.status === 422);
    await assert.rejects(service.schedules.run(users[1], schedule.id, {}), (e) => e.status === 404);
    clock = new Date('2027-02-19T17:00:00Z');
    await Promise.all([service.tick(), service.schedules.run(users[0], schedule.id, {})]);
    await service.tick(); assert.equal(provider.createCalls, before + 2);
    await service.schedules.update(users[0], schedule.id, { action: 'pause' });
    await assert.rejects(service.schedules.run(users[0], schedule.id, {}), (e) => e.code === 'BANK_SCHEDULE_INACTIVE');
    assert.equal(provider.createCalls, before + 2);
  });

  await t.test('monthly salary keeps day 31 through short months and retries bind original terms', async () => {
    const body = { accountId: checking.id, kind: 'salary', payee: 'Monthly employer', amountCents: 10000,
      frequency: 'monthly', dueOn: '2027-03-31', requestKey: randomUUID() };
    const schedule = await service.schedules.create(users[0], body), before = provider.createCalls;
    const runs = await Promise.all([service.schedules.run(users[0], schedule.id, {}), service.schedules.run(users[0], schedule.id, {})]);
    assert.equal(runs[0].id, runs[1].id); assert.equal(provider.createCalls, before + 1);
    assert.equal((await service.summary(users[0])).schedules.find((s) => s.id === schedule.id).nextDueOn, '2027-04-30');
    assert.equal((await service.schedules.create(users[0], body)).id, schedule.id);
    clock = new Date('2027-04-30T17:00:00Z');
    await service.schedules.run(users[0], schedule.id, {});
    assert.equal(provider.createCalls, before + 2);
    assert.equal((await service.summary(users[0])).schedules.find((s) => s.id === schedule.id).nextDueOn, '2027-05-31');
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
