// B9 · Give a user their own Nessie sandbox checking account.
//
// Repeat-safe in two committed steps, each under a row lock on the user's
// bank_accounts row so concurrent calls serialize:
//   1. Create the Nessie customer once and store provider_customer_id.
//   2. Reuse an account that customer already has (a crash after Nessie
//      created it but before we stored it), or create one; store its ID.
// A retry after any failure resumes from what was stored, so it never creates
// a second account. The opening balance is the starting deposit.
import { nessie as defaultNessie } from '../lib/nessie.js';

export const STARTING_BALANCE_CENTS = 150_000;
const ADDRESS = { street_number: '1', street_name: 'Puffton Village', city: 'Amherst', state: 'MA', zip: '01002' };
const clip = (text, max) => [...text].slice(0, max).join('');

export function nessieName(fullName) {
  const parts = String(fullName ?? '').trim().split(/\s+/).filter(Boolean);
  return { first_name: clip(parts[0] ?? 'Split', 40), last_name: clip(parts.slice(1).join(' ') || 'Member', 40) };
}

export const accountNickname = (userId) => `Split · ${userId.slice(0, 8)}`;

/**
 * Ensures `userId` has a linked Nessie account. Returns
 * { accountId, providerAccountId, created } where `created` is true only when
 * this call opened the Nessie account.
 */
export async function provisionBankAccount({ withTransaction, nessie = defaultNessie }, userId) {
  const lockRow = async (db) => {
    const { rows: [row] } = await db.query(
      `SELECT a.id, a.provider_customer_id AS "customerId", a.provider_account_id AS "providerAccountId",
              COALESCE(u.full_name, u.display_name) AS name
         FROM bank_accounts a JOIN users u ON u.id = a.user_id
        WHERE a.user_id = $1 FOR UPDATE OF a`,
      [userId],
    );
    return row;
  };

  await withTransaction((db) => db.query(
    `INSERT INTO bank_accounts (user_id, provider, nickname, account_type)
     VALUES ($1, 'nessie', $2, 'Checking') ON CONFLICT (user_id) DO NOTHING`,
    [userId, accountNickname(userId)],
  ));

  const customer = await withTransaction(async (db) => {
    const row = await lockRow(db);
    if (row.providerAccountId || row.customerId) return row;
    const { data } = await nessie('/customers', { method: 'POST', body: { ...nessieName(row.name), address: ADDRESS } });
    await db.query('UPDATE bank_accounts SET provider_customer_id = $2, updated_at = now() WHERE id = $1', [row.id, data.id]);
    return { ...row, customerId: data.id };
  });
  if (customer.providerAccountId) {
    return { accountId: customer.id, providerAccountId: customer.providerAccountId, created: false };
  }

  return withTransaction(async (db) => {
    const row = await lockRow(db);
    if (row.providerAccountId) return { accountId: row.id, providerAccountId: row.providerAccountId, created: false };
    const path = `/customers/${encodeURIComponent(row.customerId)}/accounts`;
    const { data: existing } = await nessie(path);
    let account = (existing?.items ?? []).find((a) => a.nickname === accountNickname(userId));
    const created = !account;
    if (!account) {
      ({ data: account } = await nessie(path, {
        method: 'POST',
        body: { type: 'Checking', nickname: accountNickname(userId), balance_cents: STARTING_BALANCE_CENTS },
      }));
    }
    await db.query(
      `UPDATE bank_accounts SET provider_account_id = $2, account_mask = $3, nickname = $4,
              balance_cents = $5, available_cents = $6, balance_as_of = now(), updated_at = now()
        WHERE id = $1`,
      [row.id, account.id, String(account.account_number ?? '').slice(-4) || null, account.nickname,
        account.balance_cents ?? null, account.available_cents ?? account.balance_cents ?? null],
    );
    return { accountId: row.id, providerAccountId: account.id, created };
  });
}
