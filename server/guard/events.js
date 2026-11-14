const descriptions = Object.freeze({
  EXPENSE_CONFIRMED: ['allowed', 'expense', 'You confirmed a shared expense.'],
  SETTLEMENT_APPROVED: ['allowed', 'settlement', 'You approved a sandbox settlement for submission.'],
  UNTRUSTED_INSTRUCTION: ['blocked', 'assistant', 'Guard blocked an untrusted payment instruction.'],
  UNTRUSTED_CONTEXT: ['blocked', 'assistant', 'Group notes are reference text and cannot authorize an action. No money was moved.'],
  ASSISTANT_ACTION_UNSUPPORTED: ['blocked', 'assistant', 'This request is outside Ask’s permitted expense and financial-read operations. No money was moved.'],
  ASSISTANT_PROPOSAL_REJECTED: ['blocked', 'assistant', 'Guard rejected an invalid assistant proposal. No financial changes were made.'],
  ASSISTANT_SCOPE_REJECTED: ['blocked', 'assistant', 'Guard rejected a proposal outside your authorized groups or participants. No financial changes were made.'],
});

export async function recordGuardEvent(db, { actorUserId, groupId = null, expenseId = null, settlementId = null, reasonCode }) {
  if (!Object.hasOwn(descriptions, reasonCode)) throw new Error('Unknown Guard event reason.');
  const [decision, source, reason] = descriptions[reasonCode];
  const { rows: [event] } = await db.query(`
    INSERT INTO guard_events (actor_user_id, group_id, expense_id, settlement_id, decision, reason_code, reason, source)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id
  `, [actorUserId, groupId, expenseId, settlementId, decision, reasonCode, reason, source]);
  return event.id;
}

export function createGuardEventsHandler(query) {
  return async ({ actor }) => {
    const { rows: events } = await query(`
      SELECT id, decision, reason_code AS "reasonCode", reason, source, group_id AS "groupId",
        expense_id AS "expenseId", settlement_id AS "settlementId", created_at AS "createdAt"
      FROM guard_events WHERE actor_user_id = $1
      ORDER BY created_at DESC, id DESC
    `, [actor.userId]);
    return { events };
  };
}
