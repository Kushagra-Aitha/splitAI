// B9/B12 · Open a user's Capital Two (Nessie sandbox) accounts: checking with
// a $1,500 opening balance and a credit card with a $2,000 limit.
//
// Opening an account is not the same as sharing it with Split: rows start
// unlinked, and `linkBankAccounts` (the Connect screen's Allow) links them.
//
// Repeat-safe in committed steps, each under a row lock on the user's
// checking row so concurrent calls serialize:
//   1. Find or create the Nessie customer and store provider_customer_id.
//   2. For each kind still missing a provider account, reuse an account that
//      customer already has with our nickname (a crash after Nessie created
//      it but before we stored it), or create one; store its ID.
// A retry after any failure resumes from what was stored, so it never opens a
// second account of the same kind.
import { nessie as defaultNessie } from '../lib/nessie.js';

export const STARTING_BALANCE_CENTS = 150_000;
export const CARD_LIMIT_CENTS = 200_000;
const ADDRESS = { street_number: '1', street_name: 'Puffton Village', city: 'Amherst', state: 'MA', zip: '01002' };
const clip = (text, max) => [...text].slice(0, max).join('');

export const ACCOUNT_KINDS = Object.freeze([
  { kind: 'checking', type: 'Checking', body: { balance_cents: STARTING_BALANCE_CENTS } },
  { kind: 'credit_card', type: 'Credit Card', body: { balance_cents: 0, credit_limit_cents: CARD_LIMIT_CENTS } },
]);

export function nessieName(fullName) {
  const parts = String(fullName ?? '').trim().split(/\s+/).filter(Boolean);
  return { first_name: clip(parts[0] ?? 'Split', 40), last_name: clip(parts.slice(1).join(' ') || 'Member', 40) };
}

/** Nicknames tie a Nessie account to one Split user and kind. */
export function accountNickname(userId, kind = 'checking') {
  return `${kind === 'credit_card' ? 'Split card' : 'Split'} · ${userId.slice(0, 8)}`;
}

/**
 * Ensures `userId` has a checking account and a credit card at Capital Two.
 * Returns { accounts: [{ kind, accountId, providerAccountId, created }] }.
 */
export async function provisionBankAccount({ withTransaction, nessie = defaultNessie }, userId) {
  const lockRows = async (db) => {
    // Lock the checking row first (the same row B4 locks for funds), then read both.
    await db.query(`SELECT id FROM bank_accounts WHERE user_id = $1 AND kind = 'checking' FOR UPDATE`, [userId]);
    const { rows } = await db.query(
      `SELECT a.id, a.kind, a.provider_customer_id AS "customerId", a.provider_account_id AS "providerAccountId",
              COALESCE(u.full_name, u.display_name) AS name
         FROM bank_accounts a JOIN users u ON u.id = a.user_id
        WHERE a.user_id = $1 FOR UPDATE OF a`,
      [userId],
    );
    return rows;
  };

  await withTransaction(async (db) => {
    for (const { kind, type } of ACCOUNT_KINDS) {
      await db.query(
        `INSERT INTO bank_accounts (user_id, provider, nickname, account_type, kind)
         VALUES ($1, 'nessie', $2, $3, $4) ON CONFLICT (user_id, kind) DO NOTHING`,
        [userId, accountNickname(userId, kind), type, kind],
      );
    }
  });

  // Step 1: the Nessie customer. Accounts mapped before B12 (demo users, B9)
  // may have an account but no stored customer: read it from that account.
  const customerId = await withTransaction(async (db) => {
    const rows = await lockRows(db);
    const known = rows.find((row) => row.customerId)?.customerId;
    if (known) return known;
    const mapped = rows.find((row) => row.providerAccountId);
    let id;
    if (mapped) ({ data: { customer_id: id } } = await nessie(`/accounts/${encodeURIComponent(mapped.providerAccountId)}`));
    if (!id) ({ data: { id } } = await nessie('/customers', { method: 'POST', body: { ...nessieName(rows[0].name), address: ADDRESS } }));
    await db.query('UPDATE bank_accounts SET provider_customer_id = $2, updated_at = now() WHERE user_id = $1', [userId, id]);
    return id;
  });

  // Step 2: each missing account, in one locked transaction per kind.
  const accounts = [];
  for (const spec of ACCOUNT_KINDS) {
    accounts.push(await withTransaction(async (db) => {
      const row = (await lockRows(db)).find((r) => r.kind === spec.kind);
      if (row.providerAccountId) return { kind: spec.kind, accountId: row.id, providerAccountId: row.providerAccountId, created: false };
      const path = `/customers/${encodeURIComponent(customerId)}/accounts`;
      const nickname = accountNickname(userId, spec.kind);
      const { data: existing } = await nessie(path);
      let account = (existing?.items ?? []).find((a) => a.nickname === nickname);
      const created = !account;
      if (!account) {
        ({ data: account } = await nessie(path, { method: 'POST', body: { type: spec.type, nickname, ...spec.body } }));
      }
      await db.query(
        `UPDATE bank_accounts SET provider_account_id = $2, account_mask = $3, nickname = $4, account_type = $5,
                balance_cents = $6, available_cents = $7, credit_limit_cents = $8, balance_as_of = now(), updated_at = now()
          WHERE id = $1`,
        [row.id, account.id, String(account.account_number ?? '').slice(-4) || null, account.nickname, spec.type,
          account.balance_cents ?? null, account.available_cents ?? account.balance_cents ?? null,
          account.credit_limit_cents ?? null],
      );
      return { kind: spec.kind, accountId: row.id, providerAccountId: account.id, created };
    }));
  }
  return { accounts };
}

/** The Connect screen's Allow: share every opened account with Split. */
export async function linkBankAccounts(db, userId) {
  const { rowCount } = await db.query(
    `UPDATE bank_accounts SET linked_at = now(), updated_at = now()
      WHERE user_id = $1 AND provider_account_id IS NOT NULL AND linked_at IS NULL`,
    [userId],
  );
  return rowCount;
}

/** What the Connect screen and account menu show. */
export async function listBankAccounts(db, userId) {
  const { rows } = await db.query(
    `SELECT id, kind, nickname, account_mask AS mask, balance_cents AS "balanceCents",
            available_cents AS "availableCents", credit_limit_cents AS "creditLimitCents",
            provider_account_id IS NOT NULL AS opened, linked_at IS NOT NULL AS linked
       FROM bank_accounts WHERE user_id = $1
      ORDER BY kind = 'checking' DESC`,
    [userId],
  );
  const kinds = new Set(rows.filter((row) => row.linked).map((row) => row.kind));
  return {
    bank: 'Capital Two',
    accounts: rows,
    needsConsent: ACCOUNT_KINDS.some(({ kind }) => !kinds.has(kind)),
  };
}
