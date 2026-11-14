// B2 · Persist Nessie activity in the bank_transactions hypertable.
//
// Re-syncing never creates duplicate rows or chart dollars: every row is keyed
// in bank_import_keys by (account_id, provider transaction ID), and the key
// and the transaction are inserted together. A transaction seen again only
// has its status (and display fields) refreshed. Provider reads happen before
// the DB transaction; the DB writes run under the account row lock that B4
// also uses for funds, so a balance refresh never interleaves with a reserve.
import { withTransaction } from '../db/pool.js';
import { reconcileSettlements } from '../ledger/reconcile-settlements.js';
import { lockAccount } from './funds.js';
import {
  listLinkedAccountsForUser,
  listMappedAccounts,
  readAccountActivity,
  readMerchants,
} from './provider.js';

// Purchases say which card paid (B12): the checking debit card or the
// Capital Two credit card.
const PURCHASE_METHOD = { checking: 'Debit card', credit_card: 'Credit card' };
const PAYMENT_METHOD = {
  purchase: 'Card',
  bill_payment: 'Bank transfer',
  transfer: 'Bank transfer',
  withdrawal: 'Cash',
};

/** Caller holds the shared account lock and transaction. No balance is invented. */
export async function persistTransactions(db, accountId, accountKind, transactions) {
  let inserted = 0;
  let updated = 0;
  let unchanged = 0;

  for (const t of transactions) {
    const key = await db.query(
      `INSERT INTO bank_import_keys (account_id, provider_key, transaction_id, occurred_at, source)
       VALUES ($1, $2, gen_random_uuid(), $3, 'nessie')
       ON CONFLICT (account_id, provider_key) DO NOTHING
       RETURNING transaction_id, occurred_at`,
      [accountId, t.providerTransactionId, t.occurredAt],
    );
    if (key.rowCount) {
      await db.query(
        `INSERT INTO bank_transactions
           (id, occurred_at, account_id, provider_transaction_id, kind, direction, amount_cents,
            status, description, merchant_name, counterparty_account_id, source, category, payment_method)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'nessie', $12, $13)`,
        [
          key.rows[0].transaction_id, key.rows[0].occurred_at, accountId, t.providerTransactionId,
          t.kind, t.direction, t.amountCents, t.status, t.description, t.merchantName,
          t.counterpartyAccountId, t.category,
          (t.kind === 'purchase' ? PURCHASE_METHOD[accountKind] : null) ?? PAYMENT_METHOD[t.kind] ?? null,
        ],
      );
      inserted++;
      continue;
    }
    // Seen before: amounts and times never change, but status settles
    // (pending → completed) and a merchant may have been renamed.
    const res = await db.query(
      `UPDATE bank_transactions t
          SET status = $3, description = $4, merchant_name = $5, category = COALESCE($6, t.category)
         FROM bank_import_keys k
        WHERE k.account_id = $1 AND k.provider_key = $2
          AND t.id = k.transaction_id AND t.occurred_at = k.occurred_at
          AND (t.status, t.description, t.merchant_name) IS DISTINCT FROM ($3, $4, $5)`,
      [accountId, t.providerTransactionId, t.status, t.description, t.merchantName, t.category],
    );
    if (res.rowCount) updated++;
    else unchanged++;
  }

  // Bank-authored categories survive merchant refreshes. B15's user overrides
  // belong in a separate field/read projection and take precedence over these.
  const metadata = await db.query(`UPDATE bank_transactions t SET category = o.category
    FROM capital_operations o WHERE o.account_id = $1 AND t.account_id = o.account_id
      AND t.provider_transaction_id = o.provider_reference
      AND o.provider_reference = ANY($2::text[])
      AND t.category IS DISTINCT FROM o.category`, [accountId, transactions.map((t) => t.providerTransactionId)]);
  updated += metadata.rowCount;
  return { inserted, updated, unchanged };
}

/**
 * Writes one account's provider snapshot. `activity` is the result of
 * readAccountActivity. Returns counts of inserted / updated / unchanged rows.
 */
export async function persistActivity(db, accountId, activity) {
  await lockAccount(db, accountId);
  const { rows: [current] } = await db.query(`
    SELECT balance_cents AS "balanceCents", available_cents AS "availableCents", kind,
      balance_as_of AS "balanceAsOf", balance_as_of >= $2::timestamptz AS stale
    FROM bank_accounts WHERE id = $1
  `, [accountId, activity.balance.balanceAsOf]);
  if (current.stale) {
    const { balanceCents, availableCents, balanceAsOf } = current;
    return { accountId, kind: current.kind, inserted: 0, updated: 0, unchanged: activity.transactions.length,
      skipped: activity.skipped, balanceCents, availableCents, balanceAsOf, changed: false };
  }
  const { inserted, updated, unchanged } = await persistTransactions(db, accountId, current.kind, activity.transactions);

  const b = activity.balance;
  const acct = await db.query(
    `UPDATE bank_accounts
        SET balance_cents = $2, available_cents = $3, balance_as_of = $4,
            account_type = COALESCE($5, account_type),
            account_mask = COALESCE(account_mask, $6),
            credit_limit_cents = COALESCE($7, credit_limit_cents),
            updated_at = now()
      WHERE id = $1
      RETURNING balance_cents AS "balanceCents", available_cents AS "availableCents",
                balance_as_of AS "balanceAsOf"`,
    [accountId, b.balanceCents, b.availableCents, b.balanceAsOf, b.accountType, b.accountMask, b.creditLimitCents ?? null],
  );
  await reconcileSettlements(db, accountId, activity);
  // `changed` lets the app skip refreshing every view when a sync found nothing new.
  const changed = inserted > 0 || updated > 0 ||
    current.balanceCents !== b.balanceCents || current.availableCents !== b.availableCents;
  return { accountId, kind: current.kind, inserted, updated, unchanged, skipped: activity.skipped, changed, ...acct.rows[0] };
}

/** Reads one mapped account from Nessie and persists it. */
export async function syncAccount(account, { merchants } = {}) {
  const activity = await readAccountActivity(account.providerAccountId, { merchants });
  return withTransaction((db) => persistActivity(db, account.id, activity));
}

/**
 * Syncs every account one user has linked (checking and card). Returns the
 * checking result plus totals across accounts, or null when nothing is linked.
 */
export async function syncForUser(db, userId) {
  const accounts = await listLinkedAccountsForUser(db, userId);
  if (!accounts.length) return null;
  const merchants = await readMerchants();
  const results = [];
  for (const account of accounts) results.push(await syncAccount(account, { merchants }));
  const checking = results.find((r) => r.kind === 'checking') ?? results[0];
  const sum = (key) => results.reduce((total, r) => total + r[key], 0);
  return {
    ...checking,
    inserted: sum('inserted'),
    updated: sum('updated'),
    unchanged: sum('unchanged'),
    changed: results.some((r) => r.changed),
    accounts: results,
  };
}

/** Syncs every mapped demo account (deploy, scripts). */
export async function syncAll(db) {
  const accounts = await listMappedAccounts(db);
  const merchants = await readMerchants();
  const results = [];
  for (const account of accounts) {
    results.push({ ...(await syncAccount(account, { merchants })), displayName: account.displayName });
  }
  return results;
}
