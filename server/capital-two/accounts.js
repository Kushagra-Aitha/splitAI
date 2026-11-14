import { HttpError } from '../http.js';
import { provisionBankAccount } from '../banking/provision.js';

export const CARD_LIMIT_CENTS = 500_000;

export async function ownedAccount(db, userId, id) {
  const { rows: [account] } = await db.query(`SELECT id, account_type AS type, provider_account_id AS reference
    FROM bank_accounts WHERE id = $1 AND user_id = $2 AND provider = 'nessie'
      AND account_type IN ('Checking', 'Credit Card') AND provider_account_id IS NOT NULL`, [id, userId]);
  if (!account) throw new HttpError(404, 'BANK_ACCOUNT_NOT_FOUND', 'Choose one of your connected bank accounts.');
  return account;
}

export async function ensureAccounts({ withTransaction, nessie }, userId) {
  const checking = await provisionBankAccount({ withTransaction, nessie }, userId);
  await withTransaction((db) => db.query(`INSERT INTO bank_accounts (user_id, account_type, nickname)
    VALUES ($1, 'Credit Card', 'Capital Two credit card') ON CONFLICT (user_id, account_type) DO NOTHING`, [userId]));
  return withTransaction(async (db) => {
    // Provisioning serializes on the card row. A lost create response is
    // recovered by exact nickname/type on the same provider customer.
    const { rows: [card] } = await db.query(`SELECT id, provider_account_id AS reference
      FROM bank_accounts WHERE user_id = $1 AND account_type = 'Credit Card' FOR UPDATE`, [userId]);
    if (card.reference) return;
    const { data: owner } = await nessie(`/accounts/${encodeURIComponent(checking.providerAccountId)}`);
    if (owner.id !== checking.providerAccountId || typeof owner.customer_id !== 'string') throw new Error('Invalid bank owner.');
    const path = `/customers/${encodeURIComponent(owner.customer_id)}/accounts`;
    const nickname = `C2 ${userId}`;
    let cursor = null, account, pages = 0;
    do {
      const params = new URLSearchParams({ limit: '100', ...(cursor ? { cursor } : {}) });
      const { data } = await nessie(`${path}?${params}`);
      account = data.items?.find((item) => item.type === 'Credit Card' && item.nickname === nickname);
      cursor = data.next_cursor || null;
      if (++pages > 20) throw new Error('Bank account listing incomplete.');
    } while (!account && cursor);
    if (!account) ({ data: account } = await nessie(path, { method: 'POST', retries: 0,
      body: { type: 'Credit Card', nickname, balance_cents: 0, credit_limit_cents: CARD_LIMIT_CENTS } }));
    if (typeof account?.id !== 'string' || !account.id ||
        !Number.isSafeInteger(account.balance_cents) || !Number.isSafeInteger(account.available_cents)) throw new Error('Invalid card response.');
    await db.query(`UPDATE bank_accounts SET provider_account_id = $2, provider_customer_id = $3,
      account_mask = $4, balance_cents = $5, available_cents = $6, credit_limit_cents = $7,
      balance_as_of = clock_timestamp(), updated_at = clock_timestamp() WHERE id = $1`,
    [card.id, account.id, owner.customer_id, String(account.account_number ?? '').slice(-4) || null,
      account.balance_cents, account.available_cents, account.credit_limit_cents ?? CARD_LIMIT_CENTS]);
  });
}
