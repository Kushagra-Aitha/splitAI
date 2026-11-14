// B1 · Nessie reads. Maps demo users to their configured sandbox accounts and
// normalizes balance and activity into one shape the rest of the app trusts.
// Provider credentials and raw payloads never leave the server.
import { nessie } from '../lib/nessie.js';

const CREDIT_KINDS = new Set(['deposit', 'interest_credit', 'refund', 'chargeback']);
const DEBIT_KINDS = new Set(['purchase', 'withdrawal', 'fee', 'bill_payment']);
const STATUSES = new Set(['pending', 'completed', 'declined', 'cancelled']);

// A user can have a checking account and a credit card (B12). Only accounts
// the user linked on the Connect screen (`linked_at`) are read or synced.
const LINKED = `a.provider = 'nessie' AND a.provider_account_id IS NOT NULL AND a.linked_at IS NOT NULL`;

/**
 * Every linked account (all users, both kinds). Pass a pool or a
 * transaction client.
 */
export async function listMappedAccounts(db) {
  const { rows } = await db.query(
    `SELECT a.id, a.user_id AS "userId", a.provider_account_id AS "providerAccountId", a.kind,
            u.display_name AS "displayName"
       FROM bank_accounts a JOIN users u ON u.id = a.user_id
      WHERE ${LINKED}
      ORDER BY u.handle, a.kind`,
  );
  return rows;
}

/**
 * The user's linked checking account, or null. Spendable funds, goals and
 * settlements always use this account; cards never pay settlements.
 */
export async function getMappedAccountForUser(db, userId) {
  const { rows } = await db.query(
    `SELECT a.id, a.user_id AS "userId", a.provider_account_id AS "providerAccountId"
       FROM bank_accounts a
      WHERE a.user_id = $1 AND a.kind = 'checking' AND ${LINKED}`,
    [userId],
  );
  return rows[0] ?? null;
}

/** All of one user's linked accounts, checking first. */
export async function listLinkedAccountsForUser(db, userId) {
  const { rows } = await db.query(
    `SELECT a.id, a.user_id AS "userId", a.provider_account_id AS "providerAccountId", a.kind
       FROM bank_accounts a
      WHERE a.user_id = $1 AND ${LINKED}
      ORDER BY a.kind = 'checking' DESC`,
    [userId],
  );
  return rows;
}

/** Balance snapshot for one provider account, in cents. */
export async function readProviderBalance(providerAccountId) {
  const balanceAsOf = new Date().toISOString();
  const { data } = await nessie(`/accounts/${encodeURIComponent(providerAccountId)}`);
  return {
    providerAccountId: data.id,
    accountType: data.type,
    nickname: data.nickname,
    accountMask: String(data.account_number ?? '').slice(-4) || null,
    balanceCents: data.balance_cents,
    availableCents: data.available_cents,
    creditLimitCents: data.credit_limit_cents ?? null,
    pendingDebitsCents: data.pending_debits_cents ?? 0,
    balanceAsOf,
  };
}

// Merchants rarely change; automatic sync (B12) reads them at most every 5 min.
const MERCHANT_TTL_MS = 5 * 60_000;
let merchantCache = null;

/** id → { name, category } for every merchant on this key (paged, cached). */
export async function readMerchants({ fresh = false } = {}) {
  if (!fresh && merchantCache && Date.now() - merchantCache.at < MERCHANT_TTL_MS) return merchantCache.names;
  const names = new Map();
  let cursor = null;
  do {
    const q = new URLSearchParams({ limit: '100', ...(cursor ? { cursor } : {}) });
    const { data } = await nessie(`/merchants?${q}`);
    for (const m of data.items ?? []) names.set(m.id, { name: m.name, category: m.category ?? null });
    cursor = data.next_cursor || null;
  } while (cursor && names.size < 2000);
  merchantCache = { at: Date.now(), names };
  return names;
}

/**
 * Turns one raw Nessie transaction into the app's shape, from the point of
 * view of `providerAccountId`. Returns null for anything that does not touch
 * that account or is malformed, so one odd row never breaks a sync.
 *
 * Direction comes from the kind: Nessie records the path account as payer_id
 * even for deposits. Only transfers use payer/payee to decide.
 */
export function normalizeTransaction(tx, providerAccountId, merchants = new Map()) {
  if (!tx || typeof tx.id !== 'string' || !tx.id) return null;
  if (!Number.isSafeInteger(tx.amount_cents) || tx.amount_cents <= 0) return null;
  if (!STATUSES.has(tx.status)) return null;
  const occurredAt = new Date(tx.created_at);
  if (Number.isNaN(occurredAt.getTime())) return null;

  let direction;
  let counterpartyAccountId = null;
  if (tx.kind === 'transfer') {
    if (tx.payer_id === providerAccountId) {
      direction = 'debit';
      counterpartyAccountId = tx.payee_id ?? null;
    } else if (tx.payee_id === providerAccountId) {
      direction = 'credit';
      counterpartyAccountId = tx.payer_id ?? null;
    } else return null;
  } else if (DEBIT_KINDS.has(tx.kind)) direction = 'debit';
  else if (CREDIT_KINDS.has(tx.kind)) direction = 'credit';
  else return null;

  if (tx.kind !== 'transfer' && tx.payer_id && tx.payer_id !== providerAccountId) return null;

  const merchant = tx.merchant_id ? merchants.get(tx.merchant_id) ?? null : null;
  const merchantName = merchant?.name ?? null;
  return {
    providerTransactionId: tx.id,
    occurredAt: occurredAt.toISOString(),
    kind: tx.kind,
    direction,
    amountCents: tx.amount_cents,
    status: tx.status,
    description: (tx.description || merchantName || tx.kind).slice(0, 200),
    merchantName,
    category: merchant?.category ?? null,
    counterpartyAccountId,
  };
}

/**
 * Balance and normalized activity for one mapped account, newest first.
 * `merchants` (from readMerchants) can be shared across accounts in one sync.
 */
export async function readAccountActivity(providerAccountId, { merchants, limit = 1000 } = {}) {
  const names = merchants ?? (await readMerchants());
  const { data } = await nessie(
    `/accounts/${encodeURIComponent(providerAccountId)}/transactions?limit=${limit}`,
  );
  // Read the balance after transaction statuses so reconciliation can release completed holds.
  const balance = await readProviderBalance(providerAccountId);
  const raw = data.items ?? [];
  const transactions = raw
    .map((tx) => normalizeTransaction(tx, providerAccountId, names))
    .filter(Boolean);
  return { balance, transactions, skipped: raw.length - transactions.length };
}
