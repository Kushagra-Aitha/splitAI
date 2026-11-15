// B17 · Settlements in the bank, in the category they pay for.
//
// A settlement pays off the payer's shares of expenses the payee paid in the
// group, oldest first, after earlier settlements between the same two people.
// Each of those expenses brings its category: the bank category (or your
// override) when it was split from a transaction, otherwise the expense's own
// category, otherwise Other. Anything left over (debts from netting or older
// data) is Other. The result is stored once per settlement.

const category = `coalesce(nullif(btrim(coalesce(bt.category_override, bt.category, e.category)), ''), 'Other')`;

/** Store the categories a pending or posted settlement pays for. Idempotent. */
export async function allocateSettlement(db, settlementId) {
  await db.query(`
    WITH me AS (
      SELECT id, group_id, payer_user_id, payee_user_id, amount_cents, created_at FROM settlements
       WHERE id = $1 AND status IN ('pending', 'posted')
         AND NOT EXISTS (SELECT 1 FROM settlement_categories WHERE settlement_id = $1)
    ), prior AS (
      SELECT coalesce(sum(s.amount_cents), 0) AS cents FROM settlements s, me
       WHERE s.group_id = me.group_id AND s.payer_user_id = me.payer_user_id AND s.payee_user_id = me.payee_user_id
         AND s.status IN ('pending', 'posted') AND (s.created_at, s.id) < (me.created_at, me.id)
    ), shares AS (
      SELECT ${category} AS category, sh.share_cents AS cents,
             sum(sh.share_cents) OVER (ORDER BY e.confirmed_at, e.id) AS upto
        FROM me
        JOIN expenses e ON e.group_id = me.group_id AND e.created_by = me.payee_user_id AND e.status = 'confirmed'
        JOIN expense_shares sh ON sh.expense_id = e.id AND sh.user_id = me.payer_user_id AND sh.share_cents > 0
        LEFT JOIN bank_import_keys k ON k.account_id = e.bank_account_id AND k.provider_key = e.bank_provider_key
        LEFT JOIN bank_transactions bt ON bt.account_id = k.account_id AND bt.id = k.transaction_id AND bt.occurred_at = k.occurred_at
    ), covered AS (
      SELECT shares.category, greatest(0, least(shares.upto, prior.cents + me.amount_cents)
             - greatest(shares.upto - shares.cents, prior.cents)) AS cents
        FROM shares, prior, me
    ), lines AS (
      SELECT category, sum(cents) AS cents FROM covered GROUP BY category
      UNION ALL
      SELECT 'Other', me.amount_cents - coalesce((SELECT sum(cents) FROM covered), 0) FROM me
    )
    INSERT INTO settlement_categories (settlement_id, category, cents)
    SELECT $1, category, sum(cents) FROM lines GROUP BY category HAVING sum(cents) > 0
    ON CONFLICT DO NOTHING`, [settlementId]);
}

/** Allocate any of the user's settlements that predate B17 or were missed. */
export async function allocateMissingSettlements(db, userId) {
  const { rows } = await db.query(`
    SELECT s.id FROM settlements s
     WHERE (s.payer_user_id = $1 OR s.payee_user_id = $1) AND s.status IN ('pending', 'posted')
       AND NOT EXISTS (SELECT 1 FROM settlement_categories c WHERE c.settlement_id = s.id)
     ORDER BY s.created_at, s.id LIMIT 50`, [userId]);
  for (const { id } of rows) await allocateSettlement(db, id);
  return rows.length;
}

// ---- Read-side fragments. `t` is bank_transactions. ----

const memo = `t.description = 'Group settlement [' || s.id::text || ']'
  OR t.description = 'Split AI settlement ' || s.id::text`;

/** LATERAL that finds the settlement behind a transfer (alias `settled`). */
export const settledJoin = `
  LEFT JOIN LATERAL (
    SELECT s.id, g.name AS "group", payer.display_name AS payer, payee.display_name AS payee
      FROM settlements s JOIN groups g ON g.id = s.group_id
      JOIN users payer ON payer.id = s.payer_user_id JOIN users payee ON payee.id = s.payee_user_id
     WHERE t.kind = 'transfer' AND t.amount_cents = s.amount_cents AND s.status IN ('pending', 'posted')
       AND ((t.direction = 'debit' AND t.account_id = s.payer_account_id)
         OR (t.direction = 'credit' AND t.account_id = s.payee_account_id))
       AND (s.provider_reference = t.provider_transaction_id OR (s.provider_reference IS NULL AND (${memo})))
     ORDER BY (s.provider_reference IS NOT NULL) DESC, s.id LIMIT 1
  ) settled ON true`;

/**
 * Category to show for a row: your override, else the main category a
 * settlement paid for, else the bank's. Needs `settled` in scope.
 */
export const displayCategory = `coalesce(t.category_override,
  (SELECT sc.category FROM settlement_categories sc WHERE sc.settlement_id = settled.id ORDER BY sc.cents DESC, sc.category LIMIT 1),
  t.category)`;

/** Columns describing a settled transfer. Needs `settled` in scope. */
export const settledColumns = `settled.id IS NOT NULL AS "settledWithSplit",
  CASE WHEN settled.id IS NOT NULL THEN json_build_object(
    'group', settled."group",
    'with', CASE WHEN t.direction = 'debit' THEN settled.payee ELSE settled.payer END,
    'direction', CASE WHEN t.direction = 'debit' THEN 'paid' ELSE 'received' END,
    'categories', CASE WHEN t.category_override IS NOT NULL
      THEN json_build_array(json_build_object('category', t.category_override, 'cents', t.amount_cents))
      ELSE (SELECT coalesce(json_agg(json_build_object('category', sc.category, 'cents', sc.cents) ORDER BY sc.cents DESC, sc.category), '[]'::json)
              FROM settlement_categories sc WHERE sc.settlement_id = settled.id) END
  ) END AS "settled"`;

/**
 * Spending, one row per (transaction, category): purchases at their amount,
 * settlements you paid as positive and settlements you received as negative
 * (a reimbursement, not income). `where` filters `t`. Columns: id,
 * occurred_at, category, cents, settled.
 */
export const spendingLines = (where) => `(
  SELECT t.id, t.occurred_at, coalesce(t.category_override, t.category, 'Other') AS category,
         t.amount_cents::bigint AS cents, false AS settled
    FROM bank_transactions t
   WHERE ${where} AND t.kind = 'purchase' AND t.direction = 'debit'
  UNION ALL
  SELECT t.id, t.occurred_at, line.category,
         CASE WHEN t.direction = 'debit' THEN line.cents ELSE -line.cents END::bigint, true
    FROM bank_transactions t
    ${settledJoin}
    CROSS JOIN LATERAL (
      SELECT sc.category, sc.cents FROM settlement_categories sc
       WHERE sc.settlement_id = settled.id AND t.category_override IS NULL
      UNION ALL
      SELECT t.category_override, t.amount_cents WHERE t.category_override IS NOT NULL
      UNION ALL
      SELECT 'Other', t.amount_cents WHERE t.category_override IS NULL
         AND NOT EXISTS (SELECT 1 FROM settlement_categories x WHERE x.settlement_id = settled.id)
    ) line
   WHERE ${where} AND t.kind = 'transfer' AND settled.id IS NOT NULL
)`;
