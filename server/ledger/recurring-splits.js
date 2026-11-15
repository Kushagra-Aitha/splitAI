import { HttpError } from '../http.js';
import { createExpenseDraft, expenseShares } from './handlers.js';

const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const invalid = (message) => new HttpError(422, 'INVALID_RECURRING_SPLIT', message);
const membership = `EXISTS (SELECT 1 FROM group_members m
  WHERE m.group_id = r.group_id AND m.user_id = r.payer_id AND m.left_at IS NULL)`;

const eligible = `FROM recurring_split_rules r
  JOIN capital_operations o ON o.schedule_id = r.schedule_id AND o.user_id = r.payer_id
  JOIN bank_accounts a ON a.id = o.account_id AND a.user_id = r.payer_id AND a.linked_at IS NOT NULL
  JOIN bank_import_keys k ON k.account_id = a.id AND k.provider_key = o.provider_reference
  JOIN bank_transactions t ON t.account_id = a.id AND t.id = k.transaction_id AND t.occurred_at = k.occurred_at
  WHERE NOT r.paused AND o.created_at >= r.active_since AND o.status IN ('pending', 'completed')
    AND (r.allocation->>'mode' <> 'exact' OR o.amount_cents = t.amount_cents AND
      (SELECT sum(value::bigint) FROM jsonb_each_text(r.allocation->'values')) = t.amount_cents)
    AND t.status IN ('pending', 'completed') AND t.kind = 'purchase' AND t.direction = 'debit'
    AND NOT EXISTS (SELECT 1 FROM recurring_split_expenses x WHERE x.operation_id = o.id)
    AND NOT EXISTS (SELECT 1 FROM expenses e WHERE e.bank_account_id = a.id
      AND e.bank_provider_key = k.provider_key AND e.status = 'confirmed')
    AND ${membership}
    AND NOT EXISTS (SELECT 1 FROM unnest(r.participant_ids) AS p(user_id)
      WHERE NOT EXISTS (SELECT 1 FROM group_members m
        WHERE m.group_id = r.group_id AND m.user_id = p.user_id AND m.left_at IS NULL))`;

export function createRecurringSplits({ query, withTransaction }) {
  async function generate(operationId = null) {
    const { rows } = await query(`SELECT o.id, r.id AS "ruleId" ${eligible}
      AND ($1::uuid IS NULL OR o.id = $1) ORDER BY o.created_at, o.id LIMIT 20`, [operationId]);
    for (const operation of rows) {
      await withTransaction(async (db) => {
        // Serialize generation against retries, pause, resume and delete.
        await db.query('SELECT id FROM recurring_split_rules WHERE id = $1 FOR UPDATE', [operation.ruleId]);
        await db.query(`SELECT g.id FROM groups g JOIN recurring_split_rules r ON r.group_id = g.id
          WHERE r.id = $1 FOR UPDATE OF g`, [operation.ruleId]);
        const { rows: [match] } = await db.query(`SELECT r.payer_id AS "payerId", r.group_id AS "groupId",
          r.participant_ids AS "participantIds", r.allocation, o.payee AS merchant,
          t.category, t.amount_cents AS cents, a.id AS "accountId", k.provider_key AS "providerKey"
          ${eligible} AND o.id = $1 AND r.id = $2`, [operation.id, operation.ruleId]);
        if (!match) return;
        const { payerId, accountId, providerKey, cents, ...fields } = match;
        const { draft } = await createExpenseDraft(db, { userId: payerId },
          { ...fields, cents: Number(cents), bankRef: { accountId, providerKey } }, { recurring: true });
        await db.query('INSERT INTO recurring_split_expenses (operation_id, expense_id) VALUES ($1, $2)',
          [operation.id, draft.id]);
      });
    }
  }

  const handlers = {
    async 'recurringSplits.list'({ actor, query: params }) {
      const groupId = params.get('group');
      const transactionId = params.get('transaction');
      if ([groupId, transactionId].some((id) => id !== null && !uuid.test(id))) throw invalid('Choose a valid group or transaction.');
      const { rows: schedules } = await query(`SELECT s.id, s.payee, s.amount_cents AS "amountCents",
        s.status, a.kind AS "accountKind"
        FROM capital_schedules s JOIN bank_accounts a ON a.id = s.account_id AND a.user_id = s.user_id
        WHERE s.user_id = $1 AND s.kind = 'purchase' AND s.day_of_month IS NOT NULL AND s.status IN ('active','paused')
          AND a.linked_at IS NOT NULL ORDER BY s.payee, s.id`, [actor.userId]);
      const { rows: rules } = await query(`SELECT r.id, r.paused, s.id AS "scheduleId", g.id AS "groupId", g.name AS "groupName",
        s.payee, s.status AS "scheduleStatus", r.allocation->>'mode' AS mode
        FROM recurring_split_rules r JOIN groups g ON g.id = r.group_id
        JOIN capital_schedules s ON s.id = r.schedule_id
        WHERE r.payer_id = $1 AND ($2::uuid IS NULL OR r.group_id = $2) AND ${membership}
        ORDER BY s.payee, r.id`, [actor.userId, groupId]);
      const { rows: drafts } = await query(`SELECT e.id, e.group_id AS "groupId", g.name AS "groupName",
        e.merchant, e.total_cents AS "totalCents", e.status, jsonb_agg(jsonb_build_object(
          'userId', u.id, 'displayName', u.display_name, 'cents', es.share_cents) ORDER BY u.display_name, u.id) AS shares
        FROM recurring_split_expenses x JOIN expenses e ON e.id = x.expense_id
        JOIN capital_operations o ON o.id = x.operation_id
        JOIN groups g ON g.id = e.group_id
        JOIN expense_shares es ON es.expense_id = e.id JOIN users u ON u.id = es.user_id
        WHERE e.created_by = $1 AND e.status = 'draft' AND ($2::uuid IS NULL OR e.group_id = $2)
          AND o.status IN ('pending','completed')
          AND EXISTS (SELECT 1 FROM group_members m WHERE m.group_id = e.group_id AND m.user_id = $1 AND m.left_at IS NULL)
          AND NOT EXISTS (SELECT 1 FROM expenses other WHERE other.bank_account_id = e.bank_account_id
            AND other.bank_provider_key = e.bank_provider_key AND other.status = 'confirmed')
        GROUP BY e.id, g.id ORDER BY e.created_at DESC LIMIT 50`, [actor.userId, groupId]);
      let previous = null;
      if (transactionId) {
        const { rows: [expense] } = await query(`SELECT e.group_id AS "groupId", o.schedule_id AS "scheduleId",
          jsonb_object_agg(es.user_id, es.share_cents) AS shares
          FROM bank_import_keys k JOIN expenses e ON e.bank_account_id = k.account_id AND e.bank_provider_key = k.provider_key
          JOIN group_members m ON m.group_id = e.group_id AND m.user_id = e.created_by AND m.left_at IS NULL
          JOIN expense_shares es ON es.expense_id = e.id
          LEFT JOIN capital_operations o ON o.account_id = k.account_id AND o.provider_reference = k.provider_key
          WHERE k.transaction_id = $2 AND e.created_by = $1 AND e.status = 'confirmed'
          GROUP BY e.id, o.schedule_id`, [actor.userId, transactionId]);
        previous = expense ?? null;
      }
      return { schedules, rules, drafts, previous };
    },

    async 'recurringSplits.create'({ actor, body }) {
      const { groupId, scheduleId, participantIds, allocation } = body;
      if (![groupId, scheduleId].every((id) => typeof id === 'string' && uuid.test(id)) ||
          !Array.isArray(participantIds) || !participantIds.length ||
          participantIds.some((id) => typeof id !== 'string' || !uuid.test(id)) ||
          new Set(participantIds).size !== participantIds.length ||
          !['equal', 'exact', 'percentage'].includes(allocation?.mode)) {
        throw invalid('Choose a payment, a group, participants, and a split method.');
      }
      try {
        return await withTransaction(async (db) => {
          const { rows: [schedule] } = await db.query(`SELECT s.amount_cents AS cents
            FROM capital_schedules s JOIN bank_accounts a ON a.id = s.account_id AND a.user_id = s.user_id
            WHERE s.id = $1 AND s.user_id = $2 AND a.linked_at IS NOT NULL
              AND s.kind = 'purchase' AND s.day_of_month IS NOT NULL AND s.status IN ('active','paused')`, [scheduleId, actor.userId]);
          if (!schedule) throw invalid('Choose a shared monthly Capital Two payment.');
          await db.query('SELECT id FROM groups WHERE id = $1 FOR UPDATE', [groupId]);
          const { rows: members } = await db.query(`SELECT user_id AS "userId" FROM group_members
            WHERE group_id = $1 AND left_at IS NULL AND user_id = ANY($2::uuid[])`,
          [groupId, [...new Set([...participantIds, actor.userId])]]);
          const selected = members.filter(({ userId }) => participantIds.includes(userId));
          if (selected.length !== participantIds.length || !members.some(({ userId }) => userId === actor.userId)) {
            throw invalid('Choose active members of your group.');
          }
          expenseShares(Number(schedule.cents), selected, allocation);
          const values = allocation.mode === 'equal' ? {} :
            Object.fromEntries(selected.map(({ userId }) => [userId, allocation.values[userId]]));
          const { rows: [rule] } = await db.query(`INSERT INTO recurring_split_rules
            (schedule_id, payer_id, group_id, participant_ids, allocation)
            VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [scheduleId, actor.userId, groupId, participantIds, { mode: allocation.mode, values }]);
          return { rule };
        });
      } catch (error) {
        if (error.code === '23505' && error.constraint === 'recurring_split_rules_schedule_id_key') {
          throw new HttpError(409, 'RECURRING_SPLIT_EXISTS', 'This payment already has a split rule.');
        }
        throw error;
      }
    },

    async 'recurringSplits.update'({ actor, params, body }) {
      if (!uuid.test(params.id) || !['pause','resume','delete'].includes(body.action)) throw invalid('Choose a rule and action.');
      const sql = body.action === 'delete' ? 'DELETE FROM recurring_split_rules' : `UPDATE recurring_split_rules
        SET paused = $3, active_since = CASE WHEN paused AND NOT $3 THEN clock_timestamp() ELSE active_since END`;
      const args = [params.id, actor.userId];
      if (body.action !== 'delete') args.push(body.action === 'pause');
      const { rows: [rule] } = await query(`${sql} WHERE id = $1 AND payer_id = $2 RETURNING id`, args);
      if (!rule) throw new HttpError(404, 'RECURRING_SPLIT_NOT_FOUND', 'Split rule not found.');
      return { rule };
    },
  };
  return { generate, handlers };
}
