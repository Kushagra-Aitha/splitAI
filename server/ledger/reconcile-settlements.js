import { HttpError } from '../http.js';

/** Called inside the bank sync transaction, with the payer account locked. */
export async function reconcileSettlements(db, accountId, activity) {
  const { rows } = await db.query(`
    SELECT s.id, s.amount_cents AS "amountCents", s.provider_reference AS reference,
      a.provider_account_id AS "payeeProviderId"
    FROM settlements s JOIN bank_accounts a ON a.id = s.payee_account_id
    WHERE s.payer_account_id = $1 AND s.status = 'pending' AND s.hold_cents > 0
    FOR UPDATE OF s
  `, [accountId]);
  for (const settlement of rows) {
    const matches = activity.transactions.filter((tx) =>
      tx.kind === 'transfer' && tx.direction === 'debit' &&
      tx.amountCents === settlement.amountCents &&
      tx.counterpartyAccountId === settlement.payeeProviderId &&
      (settlement.reference ? tx.providerTransactionId === settlement.reference :
        tx.description === `Split AI settlement ${settlement.id}`));
    if (matches.length !== 1) continue;
    const tx = matches[0];
    const posted = tx.status === 'completed';
    const failed = tx.status === 'declined' || tx.status === 'cancelled';
    if (posted && !Number.isSafeInteger(activity.balance.availableCents ?? activity.balance.balanceCents)) continue;
    await db.query(`
      UPDATE settlements
      SET provider_reference = $2, provider_status = $3,
          status = CASE WHEN $4 THEN 'posted' WHEN $5 THEN 'failed' ELSE 'pending' END,
          hold_cents = CASE WHEN $4 OR $5 THEN 0 ELSE hold_cents END,
          posted_at = CASE WHEN $4 THEN now() ELSE posted_at END,
          resolved_at = CASE WHEN $4 OR $5 THEN now() ELSE resolved_at END,
          failure_reason = CASE WHEN $5 THEN 'provider_rejected' ELSE failure_reason END,
          updated_at = now()
      WHERE id = $1 AND status = 'pending'
        AND NOT EXISTS (SELECT 1 FROM settlements WHERE provider_reference = $2 AND id <> $1)
    `, [settlement.id, tx.providerTransactionId, tx.status, posted, failed]);
  }
}

export function createSettlementLookup(query) {
  return async ({ actor, params }) => {
    if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(params.id)) {
      throw new HttpError(422, 'INVALID_REVIEW', 'Choose a valid settlement.');
    }
    const { rows: [settlement] } = await query(`
      SELECT id, group_id AS "groupId", payer_user_id AS "payerUserId",
        payee_user_id AS "payeeUserId", amount_cents AS "amountCents", status,
        provider_reference AS "providerReference"
      FROM settlements WHERE id = $1 AND payer_user_id = $2
    `, [params.id, actor.userId]);
    if (!settlement) throw new HttpError(404, 'REVIEW_NOT_FOUND', 'Settlement not found.');
    return { settlement };
  };
}
