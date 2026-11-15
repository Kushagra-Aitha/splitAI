// The provider memo is a recovery key. The app presents a separate label.
export const settlementMemo = (id) => `Group settlement [${id}]`;
export const previousSettlementMemo = (id) => `Split AI settlement ${id}`;

const memoMatches = `t.description = 'Group settlement [' || s.id::text || ']'
  OR t.description = 'Split AI settlement ' || s.id::text`;

// These fragments use the bank transaction alias t. Match only the
// corresponding debit/credit on a settlement's own accounts.
export const settlementLabelJoin = `
  LEFT JOIN LATERAL (
    SELECT CASE
      WHEN s.status = 'posted' AND t.direction = 'debit' THEN 'Settled up with ' || payee.display_name
      WHEN s.status = 'posted' THEN payer.display_name || ' paid you'
      WHEN t.direction = 'debit' THEN 'Payment to ' || payee.display_name
      ELSE 'Payment from ' || payer.display_name
    END || ' · ' || sg.name AS label
    FROM settlements s JOIN groups sg ON sg.id = s.group_id
    JOIN users payer ON payer.id = s.payer_user_id JOIN users payee ON payee.id = s.payee_user_id
    WHERE t.kind = 'transfer' AND t.amount_cents = s.amount_cents
      AND ((t.direction = 'debit' AND t.account_id = s.payer_account_id)
        OR (t.direction = 'credit' AND t.account_id = s.payee_account_id))
      AND (s.provider_reference = t.provider_transaction_id OR
        (s.provider_reference IS NULL AND (${memoMatches})))
    ORDER BY (s.provider_reference IS NOT NULL) DESC, s.id LIMIT 1
  ) settlement_label ON true`;

export const settlementDescription = `CASE
  WHEN settlement_label.label IS NOT NULL THEN settlement_label.label
  WHEN t.kind = 'transfer' AND t.description ~* '^(Split AI settlement |Group settlement \\[)[0-9a-f-]{36}\\]?$'
    THEN 'Group settlement'
  ELSE t.description END`;
