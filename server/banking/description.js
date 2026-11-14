// Presentation only: provider descriptions remain intact for reconciliation.
export const transactionDescriptionSql = `CASE WHEN t.kind='transfer' THEN coalesce((
  SELECT CASE WHEN t.account_id=s.payer_account_id THEN 'Settled up with ' || payee.display_name
    ELSE payer.display_name || ' paid you' END || ' · ' || g.name
  FROM settlements s JOIN users payer ON payer.id=s.payer_user_id
  JOIN users payee ON payee.id=s.payee_user_id JOIN groups g ON g.id=s.group_id
  WHERE t.account_id IN (s.payer_account_id,s.payee_account_id)
    AND (s.provider_reference=t.provider_transaction_id OR t.description='Split AI settlement ' || s.id::text)
  LIMIT 1),CASE WHEN t.description ~ '^Split AI settlement [0-9a-f-]{36}$' THEN 'Group settlement' ELSE t.description END)
  ELSE t.description END`;
