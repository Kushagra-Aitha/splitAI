// B9 · Bank account provisioning against live Tiger Data with a fake Nessie.
// Opt in with RUN_PROVISION_DB_TESTS=1. Uses a fresh throwaway schema and
// drops it afterwards; never calls the real Nessie API.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

function fakeNessie({ failOn } = {}) {
  const customers = new Map();
  const calls = [];
  let n = 0;
  const client = async (path, { method = 'GET', body } = {}) => {
    calls.push(`${method} ${path.replace(/cus_\w+/, ':customer')}`);
    if (failOn?.(method, path)) {
      const error = new Error('simulated provider failure');
      error.name = 'TimeoutError';
      throw error;
    }
    if (method === 'POST' && path === '/customers') {
      const id = `cus_${++n}${randomUUID().slice(0, 8)}`;
      customers.set(id, { body, accounts: [] });
      return { data: { id } };
    }
    const match = path.match(/^\/customers\/(cus_\w+)\/accounts$/);
    const customer = customers.get(match?.[1]);
    if (!customer) throw new Error(`unexpected ${method} ${path}`);
    if (method === 'GET') return { data: { items: customer.accounts, next_cursor: null } };
    const account = { id: `acct_${randomUUID().replaceAll('-', '')}`, nickname: body.nickname, account_number: `00001234${++n}`,
      balance_cents: body.balance_cents, available_cents: body.balance_cents };
    customer.accounts.push(account);
    return { data: account };
  };
  return { client, calls, customers };
}

test('live database: provisioning opens exactly one Nessie account per user, even across failures and races', {
  skip: process.env.RUN_PROVISION_DB_TESTS !== '1',
}, async (t) => {
  await import('../lib/env.js');
  const schema = `split_b_provision_${randomUUID().replaceAll('-', '')}`;
  process.env.DB_SCHEMA = schema;
  const { getPool, closePool, withTransaction } = await import('../db/pool.js');
  const { migrate } = await import('../db/migrate.js');
  const { provisionBankAccount, STARTING_BALANCE_CENTS, accountNickname } = await import('../banking/provision.js');
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

  const newUser = async (name) => {
    const { rows: [u] } = await db.query(
      `INSERT INTO users (handle, display_name, full_name, initials) VALUES ($1, $2, $2, 'XX') RETURNING id`,
      [`user-${randomUUID()}`, name],
    );
    return u.id;
  };
  const account = async (userId) => (await db.query(
    `SELECT provider_customer_id AS "customerId", provider_account_id AS "providerAccountId", account_mask AS mask,
            balance_cents AS "balanceCents", nickname FROM bank_accounts WHERE user_id = $1`, [userId])).rows;

  await t.test('first call opens the account with the starting deposit; a repeat makes no Nessie calls', async () => {
    const nessie = fakeNessie();
    const userId = await newUser('Jordan Lee');
    const first = await provisionBankAccount({ withTransaction, nessie: nessie.client }, userId);
    assert.equal(first.created, true);
    assert.deepEqual(nessie.calls, ['POST /customers', 'GET /customers/:customer/accounts', 'POST /customers/:customer/accounts']);
    const [customer] = [...nessie.customers.values()];
    assert.deepEqual({ first: customer.body.first_name, last: customer.body.last_name }, { first: 'Jordan', last: 'Lee' });
    const rows = await account(userId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].providerAccountId, first.providerAccountId);
    assert.equal(rows[0].balanceCents, STARTING_BALANCE_CENTS);
    assert.equal(rows[0].nickname, accountNickname(userId));
    assert.match(rows[0].mask, /^\d{4}$/);

    const again = await provisionBankAccount({ withTransaction, nessie: nessie.client }, userId);
    assert.deepEqual(again, { ...first, created: false });
    assert.equal(nessie.calls.length, 3);
  });

  await t.test('a lost response after Nessie opened the account is recovered, not duplicated', async () => {
    let lose = true;
    const nessie = fakeNessie();
    const flaky = async (path, options = {}) => {
      const result = await nessie.client(path, options);
      if (lose && options.method === 'POST' && path.endsWith('/accounts')) {
        lose = false;
        const error = new Error('response lost');
        error.name = 'TimeoutError';
        throw error;
      }
      return result;
    };
    const userId = await newUser('Priya');
    await assert.rejects(provisionBankAccount({ withTransaction, nessie: flaky }, userId), { name: 'TimeoutError' });
    const stuck = await account(userId);
    assert.ok(stuck[0].customerId);
    assert.equal(stuck[0].providerAccountId, null);
    const retry = await provisionBankAccount({ withTransaction, nessie: flaky }, userId);
    assert.equal(retry.created, false);
    const opened = [...nessie.customers.values()].flatMap((c) => c.accounts);
    assert.equal(opened.length, 1);
    assert.equal(retry.providerAccountId, opened[0].id);
    assert.equal(nessie.calls.filter((c) => c === 'POST /customers').length, 1);
  });

  await t.test('when Nessie is down nothing is linked, and a later retry succeeds', async () => {
    let down = true;
    const nessie = fakeNessie({ failOn: () => down });
    const userId = await newUser('Alex Rivera');
    await assert.rejects(provisionBankAccount({ withTransaction, nessie: nessie.client }, userId));
    assert.deepEqual((await account(userId)).map((a) => [a.customerId, a.providerAccountId]), [[null, null]]);
    down = false;
    assert.equal((await provisionBankAccount({ withTransaction, nessie: nessie.client }, userId)).created, true);
  });

  await t.test('two concurrent calls open one customer and one account', async () => {
    const nessie = fakeNessie();
    const userId = await newUser('Sam Park');
    const results = await Promise.all([1, 2, 3].map(() => provisionBankAccount({ withTransaction, nessie: nessie.client }, userId)));
    assert.equal(new Set(results.map((r) => r.providerAccountId)).size, 1);
    assert.equal(results.filter((r) => r.created).length, 1);
    assert.equal(nessie.calls.filter((c) => c === 'POST /customers').length, 1);
    assert.equal(nessie.calls.filter((c) => c === 'POST /customers/:customer/accounts').length, 1);
  });
});
