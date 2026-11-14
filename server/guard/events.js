import { notify } from '../notifications/notify.js';
import { HttpError } from '../http.js';
import { packCursor, pageLimit, unpackCursor } from '../lib/page-cursor.js';

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
  if (decision === 'blocked') await notify(db, { kind: 'guard_blocked', sourceId: event.id });
  return event.id;
}

export function createGuardEventsHandler(query) {
  return async ({ actor, query: params = new URLSearchParams() }) => {
    const limit = pageLimit(params.get('limit'));
    const before = unpackCursor(params.get('before'));
    const filter = params.get('filter') ?? 'all';
    const filters = { all: 'true', flagged: "e.decision = 'flagged' AND f.label IS DISTINCT FROM 'ham'",
      blocked: "e.decision = 'blocked'", held: "e.decision = 'allowed' AND s.status = 'pending'",
      approved: "e.decision = 'allowed' AND coalesce(s.status, '') <> 'pending'" };
    if (!Object.hasOwn(filters, filter)) throw new HttpError(422, 'INVALID_GUARD_FILTER', 'Choose a valid Guard tab.');
    const scope = `e.actor_user_id = $1 AND (e.comment_id IS NULL OR EXISTS (
      SELECT 1 FROM group_members m WHERE m.group_id = e.group_id AND m.user_id = $1 AND m.left_at IS NULL))`;
    const joins = `FROM guard_events e LEFT JOIN group_comments c ON c.id = e.comment_id
      LEFT JOIN guard_feedback f ON f.event_id = e.id AND f.actor_user_id = $1
      LEFT JOIN settlements s ON s.id = e.settlement_id
      LEFT JOIN groups g ON g.id = e.group_id AND EXISTS (SELECT 1 FROM group_members m
        WHERE m.group_id = g.id AND m.user_id = $1 AND m.left_at IS NULL)
      LEFT JOIN users author ON author.id = c.author_user_id`;
    const args = [actor.userId, limit + 1]; if (before) args.push(before.time, before.id);
    const { rows: [result] } = await query(`WITH page AS (
      SELECT e.id, e.decision, e.reason_code AS "reasonCode", e.reason, e.source, e.group_id AS "groupId",
        e.expense_id AS "expenseId", e.settlement_id AS "settlementId", e.comment_id AS "commentId",
        to_char(e.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt",
        g.name AS "groupName", c.text AS "commentText", author.display_name AS "authorName", f.label AS feedback,
        CASE WHEN e.decision = 'flagged' THEN 'flagged' WHEN e.decision = 'blocked' THEN 'blocked'
          WHEN s.status = 'pending' THEN 'held' ELSE 'approved' END AS status
      ${joins} WHERE ${scope} AND (${filters[filter]})
        ${before ? 'AND (e.created_at, e.id) < ($3::timestamptz, $4::uuid)' : ''}
      ORDER BY e.created_at DESC, e.id DESC LIMIT $2
    ) SELECT coalesce((SELECT jsonb_agg(p ORDER BY p."createdAt" DESC, p.id DESC) FROM page p), '[]'::jsonb) AS events,
      (SELECT count(*)::text ${joins} WHERE ${scope} AND e.decision = 'flagged' AND f.label IS DISTINCT FROM 'ham'
        AND e.created_at >= (date_trunc('week', clock_timestamp() AT TIME ZONE 'America/New_York') AT TIME ZONE 'America/New_York')) AS count`, args);
    const count = Number(result.count);
    if (!Number.isSafeInteger(count)) throw new HttpError(409, 'GUARD_STATE_INVALID', 'Guard activity needs a refresh.');
    const more = result.events.length > limit, events = result.events.slice(0, limit), last = events.at(-1);
    return { events, summary: { flaggedThisWeek: count }, nextCursor: more ? packCursor([last.createdAt, last.id]) : null };
  };
}
