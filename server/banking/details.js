// B15 · What Split knows about a bank transaction beyond the bank's row:
// the category you chose, whether it is salary, and whether it is recurring.
// Shared SQL fragments so Overview, Transactions, Insights and Ask agree.

/** Your category if you changed it, otherwise the bank's. */
export const effectiveCategory = (t = 't') => `coalesce(${t}.category_override, ${t}.category)`;

/** Capital Two direct deposits are described as payroll. */
export const isSalary = (t = 't') =>
  `(${t}.kind = 'deposit' AND ${t}.direction = 'credit' AND coalesce(${t}.description, '') ~* '^(payroll|salary|direct deposit)')`;

/**
 * Joins that add `recurring` ('scheduled' | 'detected' | null) and
 * `recurringPayee`. Scheduled: paid by a Capital Two recurring payment.
 * Detected: the same merchant and amount was paid 20–75 days earlier.
 * Needs `t` (bank_transactions) and `k` (bank_import_keys) in scope.
 */
export const recurringJoins = (t = 't', k = 'k') => `
  LEFT JOIN capital_operations rec_op ON rec_op.provider_reference = ${k}.provider_key AND rec_op.schedule_id IS NOT NULL
  LEFT JOIN capital_schedules rec_schedule ON rec_schedule.id = rec_op.schedule_id
  LEFT JOIN LATERAL (
    SELECT true AS found FROM bank_transactions prior
     WHERE prior.account_id = ${t}.account_id AND prior.kind = ${t}.kind AND prior.direction = 'debit'
       AND prior.amount_cents = ${t}.amount_cents AND prior.status IN ('pending', 'completed')
       AND lower(coalesce(prior.merchant_name, prior.description)) = lower(coalesce(${t}.merchant_name, ${t}.description))
       AND prior.occurred_at BETWEEN ${t}.occurred_at - interval '75 days' AND ${t}.occurred_at - interval '20 days'
     LIMIT 1
  ) rec_prior ON ${t}.direction = 'debit' AND ${t}.kind IN ('purchase', 'bill_payment')`;

export const recurringColumns = (t = 't') => `
  CASE WHEN rec_op.id IS NOT NULL THEN 'scheduled' WHEN rec_prior.found THEN 'detected' END AS recurring,
  rec_schedule.payee AS "recurringPayee",
  ${isSalary(t)} AS salary,
  ${t}.category AS "bankCategory",
  ${t}.category_override IS NOT NULL AS "categoryOverridden"`;

export const CATEGORY_CHOICES = Object.freeze([
  'Food & drink', 'Groceries', 'Home & bills', 'Getting around', 'Travel',
  'Shopping', 'Just for fun', 'Health', 'Subscriptions', 'Income', 'Other',
]);
