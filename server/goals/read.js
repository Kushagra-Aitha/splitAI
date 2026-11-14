import { HttpError } from '../http.js';

export function invalidGoalState() {
  return new HttpError(409, 'GOAL_STATE_INVALID', 'This goal’s saved state needs review before it can change.');
}

// SQL casts bigint values to text so this boundary can validate exact cents
// before conversion, regardless of the shared pg type parser.
export function readCents(value) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) throw invalidGoalState();
  const cents = Number(value);
  if (!Number.isSafeInteger(cents)) throw invalidGoalState();
  return cents;
}

export const goalColumns = `g.id, g.account_id AS "accountId", g.name, g.type,
  g.target_cents::text AS "targetCents", g.saved_cents::text AS "cachedSavedCents",
  g.target_date::text AS "targetDate", g.created_at AS "createdAt", g.updated_at AS "updatedAt",
  coalesce((SELECT sum(CASE WHEN m.kind = 'contribution' THEN m.amount_cents
    ELSE -m.amount_cents END) FROM goal_movements m WHERE m.goal_id = g.id), 0)::text
    AS "movementSavedCents"`;

export function goalFromRow(row) {
  const targetCents = readCents(row.targetCents);
  const savedCents = readCents(row.movementSavedCents);
  if (!targetCents || savedCents !== readCents(row.cachedSavedCents)) throw invalidGoalState();
  return {
    id: row.id,
    accountId: row.accountId,
    name: row.name,
    type: row.type,
    targetCents,
    savedCents,
    targetDate: row.targetDate,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function listGoals(db, actorId) {
  const { rows } = await db.query(
    `SELECT ${goalColumns} FROM goals g
       JOIN bank_accounts a ON a.id = g.account_id
      WHERE g.user_id = $1 AND a.user_id = $1 AND g.archived_at IS NULL
      ORDER BY g.created_at, g.id`,
    [actorId],
  );
  return { goals: rows.map(goalFromRow) };
}
