const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const settlementConditions = Object.freeze({
  settlement_sent: 's.provider_reference IS NOT NULL',
  settlement_posted: "s.status = 'posted'",
  settlement_failed: "s.status = 'failed'",
});

// Caller MUST pass its existing transaction. Recipients and links come from
// canonical rows, never a public recipient list, copied comment, or model text.
export async function notify(db, { kind, sourceId }) {
  if (typeof sourceId !== 'string' || !UUID.test(sourceId)) throw new Error('Invalid notification source.');
  let targets;
  if (kind === 'expense_added') {
    targets = `SELECT es.user_id AS recipient, e.group_id, e.id AS expense_id
      FROM expenses e JOIN expense_shares es ON es.expense_id = e.id
      JOIN group_members m ON m.group_id = e.group_id AND m.user_id = es.user_id AND m.left_at IS NULL
      WHERE e.id = $1 AND e.status = 'confirmed' AND es.user_id <> e.created_by`;
  } else if (Object.hasOwn(settlementConditions, kind)) {
    targets = `SELECT p.user_id AS recipient, s.group_id, NULL::uuid AS expense_id
      FROM settlements s CROSS JOIN LATERAL (VALUES (s.payer_user_id), (s.payee_user_id)) p(user_id)
      JOIN group_members m ON m.group_id = s.group_id AND m.user_id = p.user_id AND m.left_at IS NULL
      WHERE s.id = $1 AND ${settlementConditions[kind]}`;
  } else if (kind === 'comment_added') {
    targets = `SELECT m.user_id AS recipient, c.group_id, c.expense_id
      FROM group_comments c JOIN group_members m ON m.group_id = c.group_id AND m.left_at IS NULL
      WHERE c.id = $1 AND m.user_id <> c.author_user_id
        AND NOT EXISTS (SELECT 1 FROM guard_events e WHERE e.comment_id = c.id AND e.actor_user_id = m.user_id AND e.decision = 'flagged')`;
  } else if (kind === 'guard_flagged') {
    targets = `SELECT e.actor_user_id AS recipient, e.group_id, e.expense_id FROM guard_events e
      JOIN group_members m ON m.group_id = e.group_id AND m.user_id = e.actor_user_id AND m.left_at IS NULL
      WHERE e.comment_id = $1 AND e.decision = 'flagged'`;
  } else if (kind === 'guard_blocked') {
    targets = `SELECT actor_user_id AS recipient, NULL::uuid AS group_id, NULL::uuid AS expense_id
      FROM guard_events WHERE id = $1 AND decision = 'blocked'`;
  } else {
    throw new Error('Unsupported notification event.');
  }
  const result = await db.query(`WITH targets AS (${targets})
    INSERT INTO notifications (recipient_user_id, kind, source_id, group_id, expense_id)
    SELECT recipient, $2, $1, group_id, expense_id FROM targets
    ON CONFLICT (recipient_user_id, kind, source_id) DO NOTHING`, [sourceId, kind]);
  return result.rowCount;
}
