import { HttpError } from '../http.js';

const merchantKey = (value) => value.normalize('NFKC').toLowerCase().replace(/[^a-z0-9]/gu, '');
const shift = (date, days) => new Date(Date.parse(`${date}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

export function bankQuery(message, extraction, now = new Date()) {
  if (!extraction.merchant || /\bcash\b/iu.test(message) ||
      !/\b(?:last night|yesterday|today|this month|last (?:purchase|transaction)|bank transaction|card purchase)\b/iu.test(message)) return null;
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(now);
  const merchant = merchantKey(extraction.merchant);
  if (!merchant) throw new HttpError(422, 'BANK_MERCHANT_AMBIGUOUS', 'Choose the purchase from Transactions, or use a more specific merchant name.');
  const yesterday = /\b(?:last night|yesterday)\b/iu.test(message);
  return { merchant, cents: extraction.cents,
    from: yesterday ? shift(date, -1) : /\btoday\b/iu.test(message) ? date : /\bthis month\b/iu.test(message) ? `${date.slice(0, 8)}01` : shift(date, -30),
    to: yesterday ? date : shift(date, 1) };
}

export async function matchPurchases(db, actorId, criteria, selected, draftId = null) {
  if (!criteria) {
    if (selected != null) throw new HttpError(422, 'INVALID_BANK_SELECTION', 'Start with a request to split a bank purchase.');
    return { candidates: [], purchase: null };
  }
  if (selected != null && (!selected || typeof selected !== 'object' || Array.isArray(selected) ||
      Object.keys(selected).length !== 2 || typeof selected.accountId !== 'string' ||
      !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/iu.test(selected.accountId) ||
      typeof selected.providerKey !== 'string' || !selected.providerKey || selected.providerKey.length > 200)) {
    throw new HttpError(422, 'INVALID_BANK_SELECTION', 'Choose a matching bank purchase.');
  }
  const args = [actorId, criteria.merchant, criteria.from, criteria.to, criteria.cents, draftId];
  if (selected) args.push(selected.accountId, selected.providerKey);
  const { rows } = await db.query(`SELECT a.id AS "accountId", a.kind AS "accountKind", a.account_mask AS mask,
    t.provider_transaction_id AS "providerKey", t.merchant_name AS merchant, t.amount_cents::text AS cents,
    t.occurred_at AS "occurredAt" FROM bank_accounts a JOIN bank_transactions t ON t.account_id = a.id
    JOIN bank_import_keys k ON k.account_id = t.account_id AND k.provider_key = t.provider_transaction_id
      AND k.transaction_id = t.id AND k.occurred_at = t.occurred_at
    WHERE a.user_id = $1 AND a.linked_at IS NOT NULL AND t.source = 'nessie'
      AND t.kind = 'purchase' AND t.direction = 'debit' AND t.status IN ('pending', 'completed')
      AND regexp_replace(lower(coalesce(t.merchant_name, t.description, '')), '[^a-z0-9]', '', 'g') = $2
      AND t.occurred_at >= ($3::date::timestamp AT TIME ZONE 'America/New_York')
      AND t.occurred_at < ($4::date::timestamp AT TIME ZONE 'America/New_York')
      AND ($5::bigint IS NULL OR t.amount_cents = $5)
      AND NOT EXISTS (SELECT 1 FROM expenses e WHERE e.bank_account_id = a.id
        AND e.bank_provider_key = t.provider_transaction_id AND e.status = 'confirmed' AND e.id IS DISTINCT FROM $6::uuid)
      ${selected ? 'AND a.id = $7::uuid AND t.provider_transaction_id = $8' : ''}
    ORDER BY t.occurred_at DESC, t.id DESC LIMIT 6`, args);
  const candidates = rows.map((row) => ({ ...row, cents: Number(row.cents) }));
  if (candidates.some((row) => !Number.isSafeInteger(row.cents) || row.cents < 1)) {
    throw new HttpError(409, 'BANK_PURCHASE_INVALID', 'Refresh the bank purchase before splitting it.');
  }
  if (selected && candidates.length !== 1) throw new HttpError(409, 'BANK_PURCHASE_UNAVAILABLE', 'This matching purchase is no longer available. Refresh the proposal.');
  return { candidates, purchase: candidates.length === 1 ? candidates[0] : null };
}
