import { HttpError } from '../http.js';
import { packCursor, unpackCursor, pageLimit } from '../lib/page-cursor.js';
import { notify } from '../notifications/notify.js';

const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const timestamp = (column) => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const commentColumns = `id, group_id AS "groupId", expense_id AS "expenseId", author_user_id AS "authorUserId",
  text, ${timestamp('created_at')} AS "createdAt"`;
const invalid = (message) => new HttpError(422, 'INVALID_COMMENT', message);
const validId = (id) => typeof id === 'string' && UUID.test(id);

function commentInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      Object.keys(body).some((key) => !['text', 'expenseId', 'requestKey'].includes(key)) ||
      typeof body.text !== 'string' || !body.text.isWellFormed() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(body.text) ||
      !validId(body.requestKey) || (body.expenseId != null && !validId(body.expenseId))) {
    throw invalid('Enter a plain-text comment and a valid retry key.');
  }
  const text = body.text.trim();
  if (!text || [...text].length > 500) throw invalid('Enter a comment from 1 to 500 characters.');
  return { text, expenseId: body.expenseId?.toLowerCase() ?? null, requestKey: body.requestKey.toLowerCase() };
}

async function requireMembership(db, groupId, userId, write = false) {
  if (!validId(groupId)) throw new HttpError(422, 'INVALID_GROUP', 'Choose a valid group.');
  // A10 changes memberships under FOR UPDATE on this same group row. Reads
  // may share the lock; posting serializes with membership changes and posts.
  await db.query(`SELECT id FROM groups WHERE id = $1 FOR ${write ? 'UPDATE' : 'KEY SHARE'}`, [groupId]);
  const result = await db.query(`SELECT 1 FROM group_members
    WHERE group_id = $1 AND user_id = $2 AND left_at IS NULL`, [groupId, userId]);
  if (!result.rowCount) throw new HttpError(403, 'GROUP_SCOPE_FORBIDDEN', 'Choose one of your current groups.');
}

async function requireExpense(db, groupId, expenseId, actorId) {
  const { rows: [expense] } = await db.query(`SELECT id, merchant, total_cents AS "totalCents",
    created_by AS "paidBy", ${timestamp('confirmed_at')} AS "occurredAt",
    coalesce((SELECT share_cents FROM expense_shares WHERE expense_id = expenses.id AND user_id = $3), 0) AS "yourShareCents"
    FROM expenses WHERE id = $1 AND group_id = $2 AND status = 'confirmed'`, [expenseId, groupId, actorId]);
  if (!expense) throw new HttpError(404, 'EXPENSE_NOT_FOUND', 'Choose a confirmed expense in this group.');
  safeCents(expense.totalCents);
  if (!Number.isSafeInteger(expense.yourShareCents) || expense.yourShareCents < 0) {
    throw new HttpError(409, 'ACTIVITY_STATE_INVALID', 'Activity needs to be refreshed.');
  }
  return expense;
}

function safeCents(cents) {
  if (!Number.isSafeInteger(cents) || cents < 1) throw new HttpError(409, 'ACTIVITY_STATE_INVALID', 'Activity needs to be refreshed.');
}

const feed = `
  SELECT e.id, 'expense'::text AS type, e.confirmed_at AS occurred_at, e.created_by AS author_id,
    e.id AS expense_id, e.merchant, e.total_cents AS cents, NULL::text AS status,
    NULL::uuid AS payee_id, NULL::text AS text
  FROM expenses e WHERE e.group_id = $1 AND e.status = 'confirmed'
  UNION ALL
  SELECT s.id, 'settlement', coalesce(s.resolved_at, s.claimed_at, s.created_at), s.payer_user_id,
    NULL::uuid, NULL::text, s.amount_cents, s.status, s.payee_user_id, NULL::text
  FROM settlements s WHERE s.group_id = $1 AND s.status IN ('pending', 'posted', 'failed')
  UNION ALL
  SELECT c.id, 'comment', c.created_at, c.author_user_id, c.expense_id, NULL::text,
    NULL::bigint, NULL::text, NULL::uuid, c.text
  FROM group_comments c WHERE c.group_id = $1`;
const thread = `SELECT c.id, 'comment'::text AS type, c.created_at AS occurred_at, c.author_user_id AS author_id,
  c.expense_id, NULL::text AS merchant, NULL::bigint AS cents, NULL::text AS status,
  NULL::uuid AS payee_id, c.text FROM group_comments c WHERE c.group_id = $1 AND c.expense_id = $3`;

export function createActivityHandlers({ withTransaction }) {
  return {
    async 'activity.list'({ actor, params, query }) {
      const limit = pageLimit(query.get('limit'));
      const before = unpackCursor(query.get('before'), ['expense', 'settlement', 'comment']);
      const expenseId = query.get('expenseId');
      const focusId = query.get('focusId'), focusType = query.get('focusType');
      if (expenseId !== null && !validId(expenseId)) throw invalid('Choose a valid expense.');
      if ((focusId !== null || focusType !== null) && (!validId(focusId) ||
          !['expense', 'settlement', 'comment'].includes(focusType) || before || (expenseId && focusType !== 'comment'))) {
        throw new HttpError(422, 'INVALID_ACTIVITY_FOCUS', 'Choose a valid activity entry.');
      }
      return withTransaction(async (db) => {
        await requireMembership(db, params.id, actor.userId);
        const expense = expenseId ? await requireExpense(db, params.id, expenseId, actor.userId) : null;
        const args = [params.id, limit + 1];
        if (expenseId) args.push(expenseId);
        let cursor = before;
        if (focusId) {
          const { rows: [point] } = await db.query(`SELECT ${timestamp('occurred_at')} AS time, id, type AS kind
            FROM (${expenseId ? thread : feed}) activity WHERE id = $2 AND type = $${expenseId ? 4 : 3}`,
          expenseId ? [params.id, focusId, expenseId, focusType] : [params.id, focusId, focusType]);
          if (!point) throw new HttpError(404, 'ACTIVITY_NOT_FOUND', 'This activity is no longer available.');
          cursor = point;
        }
        const offset = args.length;
        if (cursor) args.push(cursor.time, cursor.id, cursor.kind);
        const actorIndex = args.push(actor.userId);
        const { rows: items } = await db.query(`WITH page AS (
          SELECT * FROM (${expenseId ? thread : feed}) activity
          ${cursor ? `WHERE (occurred_at, id, type) ${focusId ? '<=' : '<'} ($${offset + 1}::timestamptz, $${offset + 2}::uuid, $${offset + 3}::text)` : ''}
          ORDER BY occurred_at DESC, id DESC, type DESC LIMIT $2
        ) SELECT p.id, p.type, ${timestamp('p.occurred_at')} AS "occurredAt", p.expense_id AS "expenseId",
          p.author_id AS "authorUserId", u.display_name AS "authorName", p.merchant, p.cents AS "amountCents",
          p.status, p.payee_id AS "payeeUserId", payee.display_name AS "payeeName", p.text,
          CASE WHEN p.type = 'expense' THEN coalesce((SELECT es.share_cents FROM expense_shares es
            WHERE es.expense_id = p.id AND es.user_id = $${actorIndex}), 0) ELSE NULL END AS "yourShareCents"
        FROM page p JOIN users u ON u.id = p.author_id LEFT JOIN users payee ON payee.id = p.payee_id
        ORDER BY p.occurred_at DESC, p.id DESC, p.type DESC`, args);
        for (const item of items) {
          if (item.amountCents !== null) safeCents(item.amountCents);
          if (item.yourShareCents !== null && (!Number.isSafeInteger(item.yourShareCents) || item.yourShareCents < 0)) {
            throw new HttpError(409, 'ACTIVITY_STATE_INVALID', 'Activity needs to be refreshed.');
          }
        }
        const more = items.length > limit;
        if (more) items.pop();
        const last = items.at(-1);
        return { items, expense, nextCursor: more ? packCursor([last.occurredAt, last.id, last.type]) : null };
      });
    },

    async 'comments.create'({ actor, params, body }) {
      const { text, expenseId, requestKey } = commentInput(body);
      return withTransaction(async (db) => {
        await requireMembership(db, params.id, actor.userId, true);
        const readExisting = async () => (await db.query(`SELECT ${commentColumns} FROM group_comments
          WHERE author_user_id = $1 AND request_key = $2`, [actor.userId, requestKey])).rows[0];
        const replay = (comment) => {
          if (comment.groupId !== params.id.toLowerCase() || comment.expenseId !== expenseId || comment.text !== text) {
            throw new HttpError(409, 'COMMENT_KEY_REUSED', 'This retry key belongs to a different comment.');
          }
          return { comment };
        };
        const existing = await readExisting();
        if (existing) return replay(existing);
        if (expenseId) await requireExpense(db, params.id, expenseId, actor.userId);
        // Group-row serialization makes this per-author, per-group limit
        // race-safe without acquiring money/account locks or process caches.
        const { rows: [rate] } = await db.query(`SELECT count(*)::int AS n FROM group_comments
          WHERE group_id = $1 AND author_user_id = $2 AND created_at > clock_timestamp() - interval '1 minute'`, [params.id, actor.userId]);
        if (rate.n >= 20) throw new HttpError(429, 'COMMENT_RATE_LIMITED', 'Please wait a minute before posting more comments.');
        const { rows: [comment] } = await db.query(`INSERT INTO group_comments
          (group_id, expense_id, author_user_id, text, request_key) VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (author_user_id, request_key) DO NOTHING RETURNING ${commentColumns}`,
        [params.id, expenseId, actor.userId, text, requestKey]);
        // A concurrent request may reuse this actor's key in a different group.
        if (!comment) return replay(await readExisting());
        await notify(db, { kind: 'comment_added', sourceId: comment.id });
        return { comment };
      });
    },
  };
}
