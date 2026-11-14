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
          n.read_at AS "readAt", g.name AS "groupName"
        FROM notifications n LEFT JOIN groups g ON g.id = n.group_id
        WHERE ${visible} ${before ? 'AND (n.created_at, n.id) < ($3::timestamptz, $4::uuid)' : ''}
        ORDER BY n.created_at DESC, n.id DESC LIMIT $2
      ) SELECT coalesce((SELECT jsonb_agg(p ORDER BY p."createdAt" DESC, p.id DESC) FROM page p), '[]'::jsonb) AS items,
        (SELECT count(*)::text FROM notifications n WHERE ${visible} AND n.read_at IS NULL) AS "unreadCount"`, args);
      const count = Number(result.unreadCount);
      if (!Number.isSafeInteger(count) || count < 0) throw new HttpError(409, 'NOTIFICATION_STATE_INVALID', 'Notifications need to be refreshed.');
      const more = result.items.length > limit;
      const items = result.items.slice(0, limit);
      const last = items.at(-1);
      return { items, unreadCount: count, nextCursor: more ? packCursor([last.createdAt, last.id]) : null };
    },
    async 'notifications.read'({ actor, body }) {
      if (!body || Object.keys(body).some((key) => key !== 'ids') || !Array.isArray(body.ids) ||
          !body.ids.length || body.ids.length > 100 || body.ids.some((id) => typeof id !== 'string' || !UUID.test(id))) {
        throw new HttpError(422, 'INVALID_NOTIFICATIONS', 'Choose up to 100 notification IDs.');
      }
      // Foreign, expired-scope and nonexistent IDs behave identically. Only
      // owned, currently visible rows can change; retries retain read_at.
      await query(`UPDATE notifications n SET read_at = coalesce(n.read_at, clock_timestamp())
        WHERE ${visible} AND n.id = ANY($2::uuid[]) AND n.read_at IS NULL`, [actor.userId, [...new Set(body.ids)]]);
      return { acknowledged: true };
    },
  };
}
