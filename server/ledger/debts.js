// Positive cents mean the actor owes the counterparty. Posted settlements
// move that balance toward zero. Pending and failed transfers do not.
export async function readDebts(db, groupIds, actorId) {
  if (!groupIds.length) return [];
  const { rows } = await db.query(`
    WITH changes AS (
      SELECT e.group_id, CASE WHEN e.created_by = $2 THEN s.user_id ELSE e.created_by END AS other_id,
        CASE WHEN e.created_by = $2 THEN -s.share_cents ELSE s.share_cents END AS cents
      FROM expenses e JOIN expense_shares s ON s.expense_id = e.id
      WHERE e.group_id = ANY($1::uuid[]) AND e.status = 'confirmed'
        AND e.created_by <> s.user_id AND (e.created_by = $2 OR s.user_id = $2)
      UNION ALL
      SELECT group_id, CASE WHEN payer_user_id = $2 THEN payee_user_id ELSE payer_user_id END,
        CASE WHEN payer_user_id = $2 THEN -amount_cents ELSE amount_cents END
      FROM settlements
      WHERE group_id = ANY($1::uuid[]) AND status = 'posted'
        AND (payer_user_id = $2 OR payee_user_id = $2)
    )
    SELECT c.group_id AS "groupId", u.id AS "userId", u.display_name AS "displayName",
      sum(c.cents)::bigint AS cents
    FROM changes c JOIN users u ON u.id = c.other_id
    GROUP BY c.group_id, u.id
    HAVING sum(c.cents) <> 0
    ORDER BY u.display_name, u.id
  `, [groupIds, actorId]);
  return rows;
}

export function summarizeDebts(rows) {
  const debts = { youOwe: [], owedToYou: [], youOweCents: 0, owedToYouCents: 0 };
  for (const { userId, displayName, cents } of rows) {
    const amount = Math.abs(cents);
    const entry = { userId, displayName, cents: amount };
    if (cents > 0) {
      debts.youOwe.push(entry);
      debts.youOweCents += amount;
    } else {
      debts.owedToYou.push(entry);
      debts.owedToYouCents += amount;
    }
  }
  return debts;
}

export async function readLedger(db, groupId, actorId) {
  const { rows } = await db.query(`
    SELECT entry FROM (
      SELECT e.confirmed_at AS occurred_at, e.id,
        jsonb_build_object('type', 'expense', 'id', e.id, 'merchant', e.merchant,
          'category', e.category, 'totalCents', e.total_cents, 'paidBy', e.created_by,
          'yourShareCents', coalesce(s.share_cents, 0), 'occurredAt', e.confirmed_at) AS entry
      FROM expenses e LEFT JOIN expense_shares s ON s.expense_id = e.id AND s.user_id = $2
      WHERE e.group_id = $1 AND e.status = 'confirmed'
      UNION ALL
      SELECT coalesce(resolved_at, claimed_at, created_at), id,
        jsonb_build_object('type', 'settlement', 'id', id, 'status', status,
          'payerUserId', payer_user_id, 'payeeUserId', payee_user_id, 'amountCents', amount_cents,
          'occurredAt', coalesce(resolved_at, claimed_at, created_at))
      FROM settlements
      WHERE group_id = $1 AND status IN ('pending', 'posted', 'failed')
    ) history ORDER BY occurred_at DESC, id DESC
  `, [groupId, actorId]);
  return rows.map(({ entry }) => entry);
}
