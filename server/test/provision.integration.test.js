// B9/B12 · Capital Two provisioning against live Tiger Data with a fake Nessie.
// Opt in with RUN_PROVISION_DB_TESTS=1. Uses a fresh throwaway schema and
// drops it afterwards; never calls the real Nessie API.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

function fakeNessie({ failOn } = {}) {
  const customers = new Map();
  const accounts = new Map();
  const calls = [];
  let n = 0;
  const client = async (path, { method = 'GET', body } = {}) => {
    calls.push(`${method} ${path.replace(/cus_\w+/, ':customer').replace(/acct_\w+/, ':account')}`);
    if (failOn?.(method, path, body)) {
      const error = new Error('simulated provider failure');
      error.name = 'TimeoutError';
      throw error;
    }
    if (method === 'POST' && path === '/customers') {
      const id = `cus_${++n}${randomUUID().slice(0, 8)}`;
      customers.set(id, { body, accounts: [] });
      return { data: { id } };
    }
    const single = path.match(/^\/accounts\/(acct_\w+)$/);
    if (single) return { data: accounts.get(single[1]) };
    const match = path.match(/^\/customers\/(cus_\w+)\/accounts$/);
    const customer = customers.get(match?.[1]);
    if (!customer) throw new Error(`unexpected ${method} ${path}`);
    if (method === 'GET') return { data: { items: customer.accounts, next_cursor: null } };
    const account = { id: `acct_${randomUUID().replaceAll('-', '')}`, customer_id: match[1], type: body.type,
      nickname: body.nickname, account_number: `00001234${++n}`, balance_cents: body.balance_cents,
      available_cents: body.credit_limit_cents ?? body.balance_cents, credit_limit_cents: body.credit_limit_cents ?? null };
    customer.accounts.push(account);
    accounts.set(account.id, account);
    return { data: account };
  };
  /** An account that exists before provisioning (a demo or B9 user). */
  const seedAccount = (type = 'Checking') => {
    const customerId = `cus_pre${randomUUID().slice(0, 8)}`;
    const account = { id: `acct_${randomUUID().replaceAll('-', '')}`, customer_id: customerId, type, nickname: 'Pre-existing',
      account_number: '000099991111', balance_cents: 50_000, available_cents: 50_000 };
    customers.set(customerId, { body: {}, accounts: [account] });
    accounts.set(account.id, account);
    return account;
  };
  const opened = () => [...customers.values()].flatMap((c) => c.accounts);
  return { client, calls, customers, seedAccount, opened };
}

test('live database: Capital Two opens one checking and one card per user, even across failures and races', {
  skip: process.env.RUN_PROVISION_DB_TESTS !== '1',
}, async (t) => {
  await import('../lib/env.js');
  const schema = `split_b_provision_${randomUUID().replaceAll('-', '')}`;
  process.env.DB_SCHEMA = schema;
  const { getPool, closePool, withTransaction } = await import('../db/pool.js');
  const { migrate } = await import('../db/migrate.js');
  const { provisionBankAccount, linkBankAccounts, listBankAccounts, STARTING_BALANCE_CENTS, CARD_LIMIT_CENTS, accountNickname } =
    await import('../banking/provision.js');
  const { accountIdForUser } = await import('../banking/overview.js');
  const { getMappedAccountForUser, listLinkedAccountsForUser } = await import('../banking/provider.js');
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
  const rowsFor = async (userId) => (await db.query(
    `SELECT kind, provider_customer_id AS "customerId", provider_account_id AS "providerAccountId", account_mask AS mask,
            balance_cents AS "balanceCents", credit_limit_cents AS "creditLimitCents", nickname, linked_at AS "linkedAt"
       FROM bank_accounts WHERE user_id = $1 ORDER BY kind`, [userId])).rows;
  const provision = (nessie, userId) => provisionBankAccount({ withTransaction, nessie: nessie.client }, userId);
  const count = (nessie, call) => nessie.calls.filter((c) => c === call).length;

  await t.test('first call opens checking ($1,500) and a card ($2,000 limit); a repeat makes no Nessie calls', async () => {
    const nessie = fakeNessie();
    const userId = await newUser('Jordan Lee');
    const first = await provision(nessie, userId);
    assert.deepEqual(first.accounts.map((a) => [a.kind, a.created]), [['checking', true], ['credit_card', true]]);
    assert.equal(count(nessie, 'POST /customers'), 1);
    assert.equal(count(nessie, 'POST /customers/:customer/accounts'), 2);
    const [customer] = [...nessie.customers.values()];
    assert.deepEqual({ first: customer.body.first_name, last: customer.body.last_name }, { first: 'Jordan', last: 'Lee' });
    const [checking, card] = await rowsFor(userId);
    assert.equal(checking.kind, 'checking');
    assert.equal(checking.balanceCents, STARTING_BALANCE_CENTS);
    assert.equal(checking.nickname, accountNickname(userId, 'checking'));
    assert.equal(card.kind, 'credit_card');
    assert.equal(card.creditLimitCents, CARD_LIMIT_CENTS);
    assert.equal(card.nickname, accountNickname(userId, 'credit_card'));
    assert.match(checking.mask, /^\d{4}$/);
    assert.equal(checking.customerId, card.customerId);

    // Opened is not shared: nothing is linked until Allow.
    assert.equal(checking.linkedAt, null);
    assert.equal(await accountIdForUser(db, userId), null);
    assert.equal((await listBankAccounts(db, userId)).needsConsent, true);

    const callsBefore = nessie.calls.length;
    const again = await provision(nessie, userId);
    assert.ok(again.accounts.every((a) => !a.created));
    assert.equal(nessie.calls.length, callsBefore);
  });

  await t.test('Allow links both accounts; checking is the account funds and settlements use', async () => {
    const nessie = fakeNessie();
    const userId = await newUser('Maya Chen');
    await provision(nessie, userId);
    assert.equal(await linkBankAccounts(db, userId), 2);
    assert.equal(await linkBankAccounts(db, userId), 0);
    const listing = await listBankAccounts(db, userId);
    assert.equal(listing.needsConsent, false);
    assert.deepEqual(listing.accounts.map((a) => [a.kind, a.linked]), [['checking', true], ['credit_card', true]]);
    const checkingId = await accountIdForUser(db, userId);
    assert.equal((await getMappedAccountForUser(db, userId)).id, checkingId);
    assert.deepEqual((await listLinkedAccountsForUser(db, userId)).map((a) => a.kind), ['checking', 'credit_card']);
  });

  await t.test('a user mapped before B12 keeps their checking account and only gets a card', async () => {
    const nessie = fakeNessie();
    const pre = nessie.seedAccount();
    const userId = await newUser('Sam Park');
    await db.query(
      `INSERT INTO bank_accounts (user_id, provider, provider_account_id, kind, linked_at) VALUES ($1, 'nessie', $2, 'checking', now())`,
      [userId, pre.id],
    );
    const result = await provision(nessie, userId);
    assert.deepEqual(result.accounts.map((a) => [a.kind, a.created]), [['checking', false], ['credit_card', true]]);
    assert.equal(count(nessie, 'POST /customers'), 0, 'reuses the existing customer');
    assert.equal(count(nessie, 'GET /accounts/:account'), 1);
    const [checking, card] = await rowsFor(userId);
    assert.equal(checking.providerAccountId, pre.id);
    assert.equal(card.customerId, pre.customer_id);
    assert.equal((await listBankAccounts(db, userId)).needsConsent, true, 'the new card still needs Allow');
  });

  await t.test('a lost response after Nessie opened the card is recovered, not duplicated', async () => {
    let lose = true;
    const nessie = fakeNessie();
    const flaky = async (path, options = {}) => {
      const result = await nessie.client(path, options);
      if (lose && options.method === 'POST' && options.body?.type === 'Credit Card') {
        lose = false;
        const error = new Error('response lost');
        error.name = 'TimeoutError';
        throw error;
      }
      return result;
    };
    const userId = await newUser('Priya');
    await assert.rejects(provisionBankAccount({ withTransaction, nessie: flaky }, userId), { name: 'TimeoutError' });
    const [checking, card] = await rowsFor(userId);
    assert.ok(checking.providerAccountId);
    assert.equal(card.providerAccountId, null);
    const retry = await provisionBankAccount({ withTransaction, nessie: flaky }, userId);
    assert.deepEqual(retry.accounts.map((a) => [a.kind, a.created]), [['checking', false], ['credit_card', false]]);
    assert.equal(nessie.opened().filter((a) => a.type === 'Credit Card').length, 1);
    assert.equal(nessie.opened().length, 2);
  });

  await t.test('when Nessie is down nothing is opened, and a later retry succeeds', async () => {
    let down = true;
    const nessie = fakeNessie({ failOn: () => down });
    const userId = await newUser('Alex Rivera');
    await assert.rejects(provision(nessie, userId));
    assert.ok((await rowsFor(userId)).every((row) => row.customerId === null && row.providerAccountId === null));
    down = false;
    assert.ok((await provision(nessie, userId)).accounts.every((a) => a.created));
  });

  await t.test('concurrent calls open one customer, one checking and one card', async () => {
    const nessie = fakeNessie();
    const userId = await newUser('Sam Park');
    const results = await Promise.all([1, 2, 3].map(() => provision(nessie, userId)));
    for (const kind of ['checking', 'credit_card']) {
      const mine = results.map((r) => r.accounts.find((a) => a.kind === kind));
      assert.equal(new Set(mine.map((a) => a.providerAccountId)).size, 1, kind);
      assert.equal(mine.filter((a) => a.created).length, 1, kind);
    }
    assert.equal(count(nessie, 'POST /customers'), 1);
    assert.equal(count(nessie, 'POST /customers/:customer/accounts'), 2);
  });
});
