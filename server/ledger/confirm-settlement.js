import { recordGuardEvent } from '../guard/events.js';
import { HttpError } from '../http.js';
import { nessie, NessieError } from '../lib/nessie.js';
import { readDebts } from './debts.js';

const reviewColumns = `id, group_id AS "groupId", payer_user_id AS "payerUserId",
  payee_user_id AS "payeeUserId", amount_cents AS "amountCents", status,
  provider_reference AS "providerReference"`;

export function createSettlementConfirmation({ withTransaction, lockAccount, reserveFunds, transfer = nessie }) {
  return async function confirmSettlement({ actor, params }) {
    const { id } = params;
    if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id)) {
      throw new HttpError(422, 'INVALID_REVIEW', 'Choose a valid settlement review.');
    }
    const claim = await withTransaction(async (db) => {
      const owner = [id, actor.userId];
      const { rows: [account] } = await db.query(
        'SELECT payer_account_id AS id FROM settlements WHERE id = $1 AND payer_user_id = $2', owner,
      );
      if (!account) throw new HttpError(404, 'REVIEW_NOT_FOUND', 'Settlement review not found.');
      await lockAccount(db, account.id);
      const { rows: [review] } = await db.query(`
        SELECT ${reviewColumns}, payer_account_id AS "payerAccountId", payee_account_id AS "payeeAccountId",
          review_expires_at <= clock_timestamp() AS expired
        FROM settlements WHERE id = $1 AND payer_user_id = $2 FOR UPDATE
      `, owner);
      if (!review) throw new HttpError(404, 'REVIEW_NOT_FOUND', 'Settlement review not found.');
      const { payerAccountId, payeeAccountId, expired, ...settlement } = review;
      if (settlement.status === 'pending' || settlement.status === 'posted' || settlement.status === 'failed') {
        return { settlement };
      }
      if (expired || settlement.status !== 'reviewed') {
        throw new HttpError(409, 'REVIEW_EXPIRED', 'Create a new settlement review.');
      }

      await db.query('SELECT id FROM groups WHERE id = $1 FOR UPDATE', [review.groupId]);
      const { rows: members } = await db.query(`
        SELECT user_id FROM group_members WHERE group_id = $1 AND left_at IS NULL
          AND user_id IN ($2, $3)
      `, [review.groupId, actor.userId, review.payeeUserId]);
      if (members.length !== 2) {
        throw new HttpError(409, 'GROUP_MEMBERSHIP_CHANGED', 'Both people must still belong to the group.');
      }
      const debts = await readDebts(db, [review.groupId], actor.userId);
      const currentDebt = debts.find((debt) => debt.userId === review.payeeUserId)?.cents ?? 0;
      const { rows: [pending] } = await db.query(`
        SELECT coalesce(sum(amount_cents), 0)::bigint AS cents FROM settlements
        WHERE group_id = $1 AND payer_user_id = $2 AND payee_user_id = $3 AND status = 'pending'
      `, [review.groupId, actor.userId, review.payeeUserId]);
      if (currentDebt - pending.cents < review.amountCents) {
        throw new HttpError(409, 'DEBT_CHANGED', 'The debt has changed or a settlement is already pending.');
      }
      const { rows: accounts } = await db.query(`
        SELECT id, provider_account_id AS "providerAccountId" FROM bank_accounts
        WHERE provider = 'nessie' AND provider_account_id IS NOT NULL
          AND ((id = $1 AND user_id = $2) OR (id = $3 AND user_id = $4))
      `, [payerAccountId, actor.userId, payeeAccountId, review.payeeUserId]);
      const payer = accounts.find((row) => row.id === payerAccountId);
      const payee = accounts.find((row) => row.id === payeeAccountId);
      if (!payer || !payee) throw new HttpError(409, 'NO_LINKED_ACCOUNT', 'Both members need a connected sandbox account.');
      try {
        await reserveFunds(db, payerAccountId, review.amountCents);
      } catch (error) {
        if (error.code === 'INSUFFICIENT_FUNDS' || error.code === 'BALANCE_UNKNOWN') {
          throw new HttpError(409, error.code, 'The account does not have enough verified spendable funds.');
        }
        throw error;
      }
      await db.query(`
        UPDATE settlements SET status = 'pending', hold_cents = amount_cents,
          claimed_at = clock_timestamp(), updated_at = clock_timestamp()
        WHERE id = $1
      `, [id]);
      await recordGuardEvent(db, { actorUserId: actor.userId, groupId: review.groupId, settlementId: id,
        reasonCode: 'SETTLEMENT_APPROVED' });
      return { settlement: { ...settlement, status: 'pending' }, payer, payee };
    });

    if (!claim.payer) return { settlement: claim.settlement };

    // The claim commits before the provider call. An ambiguous outcome leaves
    // the hold in place for A8. Re-confirming never sends another request.
    let result;
    try {
      result = await transfer(`/accounts/${encodeURIComponent(claim.payer.providerAccountId)}/transfers`, {
        method: 'POST',
        retries: 0,
        body: {
          payee_id: claim.payee.providerAccountId,
          amount_cents: claim.settlement.amountCents,
          description: `Split AI settlement ${id}`,
        },
      });
    } catch (error) {
      if (!(error instanceof NessieError) || ![400, 401, 403, 404, 422, 429].includes(error.status)) {
        return { settlement: claim.settlement };
      }
      return withTransaction(async (db) => {
        await lockAccount(db, claim.payer.id);
        const { rows: [settlement] } = await db.query(`
          UPDATE settlements SET status = 'failed', hold_cents = 0,
            failure_reason = 'provider_rejected', resolved_at = clock_timestamp(), updated_at = clock_timestamp()
          WHERE id = $1 AND status = 'pending' RETURNING ${reviewColumns}
        `, [id]);
        if (settlement) return { settlement };
        const { rows } = await db.query(`SELECT ${reviewColumns} FROM settlements WHERE id = $1`, [id]);
        return { settlement: rows[0] };
      });
    }

    const { data } = result;
    if (typeof data?.id !== 'string' || !data.id.trim()) return { settlement: claim.settlement };
    return withTransaction(async (db) => {
      await lockAccount(db, claim.payer.id);
      await db.query(`
        UPDATE settlements SET provider_reference = $2, provider_status = $3, updated_at = clock_timestamp()
        WHERE id = $1 AND status = 'pending' AND provider_reference IS NULL
      `, [id, data.id, typeof data.status === 'string' ? data.status : null]);
      const { rows } = await db.query(`SELECT ${reviewColumns} FROM settlements WHERE id = $1`, [id]);
      return { settlement: rows[0] };
    });
  };
}
