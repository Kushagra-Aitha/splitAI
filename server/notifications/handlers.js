import { HttpError } from '../http.js';
import { packCursor, unpackCursor, pageLimit } from '../lib/page-cursor.js';
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const visible = `n.recipient_user_id = $1 AND (n.group_id IS NULL OR EXISTS (
  SELECT 1 FROM group_members m WHERE m.group_id = n.group_id AND m.user_id = $1 AND m.left_at IS NULL))`;

export function createNotificationHandlers({ query }) {
  return {
    async 'notifications.list'({ actor, query: params }) {
      const limit = pageLimit(params.get('limit'));
      const before = unpackCursor(params.get('before'));
      const args = [actor.userId, limit + 1];
      if (before) args.push(before.time, before.id);
      const { rows: [result] } = await query(`WITH page AS (
        SELECT n.id, n.kind, n.source_id AS "sourceId", n.group_id AS "groupId", n.expense_id AS "expenseId",
          to_char(n.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt",
          n.read_at AS "readAt", g.name AS "groupName", u.id AS "actorUserId", u.display_name AS "actorName",
          e.merchant, e.total_cents::text AS "totalCents", es.share_cents::text AS "yourShareCents",
          s.amount_cents::text AS "settlementCents", s.payer_user_id = $1 AS "isPayer",
          payee.display_name AS "payeeName"
        FROM notifications n LEFT JOIN groups g ON g.id = n.group_id
        LEFT JOIN expenses e ON e.id = n.expense_id AND e.group_id = n.group_id
        LEFT JOIN expense_shares es ON es.expense_id = e.id AND es.user_id = $1
        LEFT JOIN group_comments c ON n.kind IN ('comment_added', 'guard_flagged') AND c.id = n.source_id AND c.group_id = n.group_id
        LEFT JOIN settlements s ON n.kind IN ('settlement_sent', 'settlement_posted', 'settlement_failed')
          AND s.id = n.source_id AND s.group_id = n.group_id
        LEFT JOIN users u ON u.id = CASE WHEN n.kind = 'expense_added' THEN e.created_by
          WHEN n.kind IN ('comment_added', 'guard_flagged') THEN c.author_user_id WHEN s.id IS NOT NULL THEN s.payer_user_id
          WHEN n.kind = 'guard_blocked' THEN n.recipient_user_id END
        LEFT JOIN users payee ON payee.id = s.payee_user_id
        WHERE ${visible} ${before ? 'AND (n.created_at, n.id) < ($3::timestamptz, $4::uuid)' : ''}
        ORDER BY n.created_at DESC, n.id DESC LIMIT $2
      ) SELECT coalesce((SELECT jsonb_agg(p ORDER BY p."createdAt" DESC, p.id DESC) FROM page p), '[]'::jsonb) AS items,
        (SELECT count(*)::text FROM notifications n WHERE ${visible} AND n.read_at IS NULL) AS "unreadCount"`, args);
      const count = Number(result.unreadCount);
      if (!Number.isSafeInteger(count) || count < 0) throw new HttpError(409, 'NOTIFICATION_STATE_INVALID', 'Notifications need to be refreshed.');
      const more = result.items.length > limit;
      const items = result.items.slice(0, limit);
      for (const item of items) for (const field of ['totalCents', 'yourShareCents', 'settlementCents']) {
        if (item[field] === null) continue;
        item[field] = Number(item[field]);
        if (!Number.isSafeInteger(item[field]) || item[field] < 0) throw new HttpError(409, 'NOTIFICATION_STATE_INVALID', 'Notifications need to be refreshed.');
      }
      const last = items.at(-1);
      return { items, unreadCount: count, nextCursor: more ? packCursor([last.createdAt, last.id]) : null };
    },
    async 'notifications.read'({ actor, body }) {
      const all = !!body && body.all === true && Object.keys(body).length === 1;
      if (!all && (!body || Object.keys(body).some((key) => key !== 'ids') || !Array.isArray(body.ids) ||
          !body.ids.length || body.ids.length > 100 || body.ids.some((id) => typeof id !== 'string' || !UUID.test(id)))) {
        throw new HttpError(422, 'INVALID_NOTIFICATIONS', 'Choose up to 100 notification IDs.');
      }
      // Foreign, expired-scope and nonexistent IDs behave identically. Only
      // owned, currently visible rows can change; retries retain read_at.
      await query(`UPDATE notifications n SET read_at = coalesce(n.read_at, clock_timestamp())
        WHERE ${visible} ${all ? '' : 'AND n.id = ANY($2::uuid[])'} AND n.read_at IS NULL`,
      all ? [actor.userId] : [actor.userId, [...new Set(body.ids)]]);
      return { acknowledged: true };
    },
  };
}
