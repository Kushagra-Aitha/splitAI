import { HttpError } from '../http.js';
import { packCursor, unpackCursor } from '../lib/page-cursor.js';
import { readCents } from './read.js';

export async function goalHistory(db, actorId, goalId, params) {
  if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/iu.test(goalId)) throw new HttpError(422, 'INVALID_GOAL_INPUT', 'Choose a valid goal.');
  const before = unpackCursor(params.get('before'));
  const { rowCount } = await db.query(`SELECT g.id FROM goals g JOIN bank_accounts a ON a.id = g.account_id
    WHERE g.id = $1 AND g.user_id = $2 AND a.user_id = $2 AND g.archived_at IS NULL`, [goalId, actorId]);
  if (!rowCount) throw new HttpError(403, 'GOAL_SCOPE_FORBIDDEN', 'Choose a goal belonging to your account.');
  const { rows } = await db.query(`SELECT m.id, m.kind, m.amount_cents::text AS cents,
    to_char(m.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt"
    FROM goal_movements m JOIN goals g ON g.id = m.goal_id JOIN bank_accounts a ON a.id = g.account_id
    WHERE g.id = $1 AND g.user_id = $2 AND a.user_id = $2 AND g.archived_at IS NULL
      ${before ? 'AND (m.created_at, m.id) < ($3::timestamptz, $4::uuid)' : ''}
    ORDER BY m.created_at DESC, m.id DESC LIMIT 21`, before ? [goalId, actorId, before.time, before.id] : [goalId, actorId]);
  const items = rows.slice(0, 20).map((row) => ({ ...row, cents: readCents(row.cents) }));
  const last = items.at(-1);
  return { items, nextCursor: rows.length > 20 ? packCursor([last.createdAt, last.id]) : null };
}
