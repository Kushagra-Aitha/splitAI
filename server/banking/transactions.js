import { settlementDescription, settlementLabelJoin } from '../ledger/settlement-labels.js';
import { HttpError } from '../http.js';
import { TIME_ZONE } from './overview.js';

const PAGE_SIZE = 50;

export async function listTransactions(db, userId, query) {
  const account = query.get('account') || null;
  const category = query.get('category') || null;
  const unsplit = query.get('unsplit') === 'true';
  const offset = Number(query.get('offset') ?? 0);
  const id = query.get('id') || null;
  if ((account && !['checking', 'credit_card'].includes(account)) ||
      !Number.isSafeInteger(offset) || offset < 0 || (id && !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/iu.test(id))) {
    throw new HttpError(422, 'INVALID_TRANSACTION_FILTER', 'Choose a valid account and page.');
  }

  const { rows } = await db.query(`
    SELECT t.id, t.kind, t.direction, t.amount_cents AS "amountCents", ${settlementDescription} AS description,
           CASE WHEN settlement_label.label IS NULL THEN t.merchant_name END AS "merchantName", t.category, t.status, t.source,
           t.occurred_at AS "occurredAt", a.id AS "accountId", a.kind AS "accountKind",
           a.account_mask AS "accountMask", k.provider_key AS "providerKey",
           g.name AS "splitGroupName",
           CASE WHEN e.id IS NOT NULL THEN
             (SELECT coalesce(sum(s.share_cents), 0)::bigint FROM expense_shares s
              WHERE s.expense_id = e.id AND s.user_id <> e.created_by)
           END AS "splitOwedCents",
           CASE WHEN e.id IS NULL AND t.kind = 'purchase' AND t.direction = 'debit'
             AND k.provider_key IS NOT NULL AND t.status IN ('pending', 'completed') THEN
             CASE WHEN suggestions.name IS NOT NULL THEN 'Split with ' || suggestions.name
                  WHEN lower(t.category) IN ('home & bills', 'rent', 'utilities') OR coalesce(t.merchant_name, t.description) ~* '\\m(rent|utilities)\\M' THEN 'Rent or utilities'
                  WHEN lower(t.category) IN ('food & drink', 'restaurant', 'restaurants', 'dining') AND t.amount_cents >= 5000 THEN 'Large food or drink purchase'
             END
           END AS "suggestion",
           suggestions.id AS "suggestedGroupId",
           coalesce(k.imported_at >= now() - interval '90 seconds', false) AND t.source = 'nessie' AS "recentlyImported"
      FROM bank_accounts a
      JOIN bank_transactions t ON t.account_id = a.id
      LEFT JOIN bank_import_keys k ON k.account_id = a.id AND k.transaction_id = t.id AND k.occurred_at = t.occurred_at
      LEFT JOIN expenses e ON e.bank_account_id = a.id AND e.bank_provider_key = k.provider_key AND e.status = 'confirmed'
      LEFT JOIN groups g ON g.id = e.group_id
      ${settlementLabelJoin}
      LEFT JOIN LATERAL (
        SELECT candidate.id, candidate.name
          FROM group_members m JOIN groups candidate ON candidate.id = m.group_id
          LEFT JOIN LATERAL (
            SELECT max(old.confirmed_at) AS last_split
              FROM expenses old
              JOIN bank_import_keys old_key ON old_key.account_id = old.bank_account_id
                AND old_key.provider_key = old.bank_provider_key
              JOIN bank_transactions old_tx ON old_tx.account_id = old_key.account_id
                AND old_tx.id = old_key.transaction_id AND old_tx.occurred_at = old_key.occurred_at
             WHERE old.group_id = candidate.id AND old.created_by = a.user_id
               AND old.status = 'confirmed'
               AND lower(coalesce(old_tx.merchant_name, old_tx.description)) = lower(coalesce(t.merchant_name, t.description))
          ) history ON true
         WHERE m.user_id = a.user_id AND m.left_at IS NULL AND (
           history.last_split IS NOT NULL OR (
             candidate.kind = 'trip' AND
             (t.occurred_at AT TIME ZONE '${TIME_ZONE}')::date BETWEEN candidate.starts_on AND candidate.ends_on
           )
         )
         ORDER BY history.last_split DESC NULLS LAST, candidate.id
         LIMIT 1
      ) suggestions ON e.id IS NULL AND t.kind = 'purchase' AND t.direction = 'debit'
        AND k.provider_key IS NOT NULL AND t.status IN ('pending', 'completed')
     WHERE a.user_id = $1 AND a.linked_at IS NOT NULL
       AND ($7::uuid IS NULL OR t.id = $7)
       AND ($2::text IS NULL OR a.kind = $2)
       AND ($3::text IS NULL OR coalesce(t.category, 'Other') = $3)
       AND (NOT $4 OR (
         e.id IS NULL AND t.kind = 'purchase' AND t.direction = 'debit'
         AND k.provider_key IS NOT NULL AND t.status IN ('pending', 'completed')
       ))
     ORDER BY t.occurred_at DESC, t.id, a.id
     LIMIT $5 OFFSET $6
  `, [userId, account, category, unsplit, PAGE_SIZE + 1, offset, id]);
  const { rows: categories } = await db.query(`
    SELECT DISTINCT coalesce(t.category, 'Other') AS category
    FROM bank_accounts a JOIN bank_transactions t ON t.account_id = a.id
    WHERE a.user_id = $1 AND a.linked_at IS NOT NULL
    ORDER BY category
  `, [userId]);
  return {
    transactions: rows.slice(0, PAGE_SIZE),
    categories: categories.map(({ category }) => category),
    nextOffset: rows.length > PAGE_SIZE ? offset + PAGE_SIZE : null,
  };
}
