import { HttpError } from '../http.js';
import { readDebts } from '../ledger/debts.js';
import { notify } from '../notifications/notify.js';
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/iu;
const invalid = (message) => new HttpError(422, 'INVALID_REMINDER', message);
const unavailable = () => new HttpError(404, 'REMINDER_UNAVAILABLE', 'This reminder or debt is not available.');
const normalized = (s) => s.normalize('NFKC').trim().toLocaleLowerCase('en-US');
const columns = `r.id, r.group_id AS "groupId", r.recipient_user_id AS "recipientUserId", r.expense_id AS "expenseId",
  r.amount_cents AS "amountCents", r.status, r.expires_at AS "expiresAt", g.name AS "groupName",
  u.display_name AS "recipientName", e.merchant`;
export function createReminderHandlers({ query, withTransaction }) {
  async function read(db, actorId, id) {
    const { rows: [draft] } = await db.query(`SELECT ${columns} FROM debt_reminders r
      JOIN groups g ON g.id = r.group_id JOIN users u ON u.id = r.recipient_user_id
      LEFT JOIN expenses e ON e.id = r.expense_id AND e.group_id = r.group_id
      WHERE r.id = $1 AND r.sender_user_id = $2 AND EXISTS (SELECT 1 FROM group_members m
        WHERE m.group_id = r.group_id AND m.user_id = $2 AND m.left_at IS NULL)`, [id, actorId]);
    if (!draft) throw unavailable();
    if (!Number.isSafeInteger(draft.amountCents) || draft.amountCents < 1) throw new HttpError(409, 'DEBT_STATE_INVALID', 'Refresh this debt before sending a reminder.');
    return draft;
  }
  async function canonical(db, actorId, groupId, recipientId, expenseId) {
    const { rowCount } = await db.query(`SELECT 1 FROM group_members sender JOIN group_members recipient
      ON recipient.group_id = sender.group_id AND recipient.user_id = $3 AND recipient.left_at IS NULL
      WHERE sender.group_id = $1 AND sender.user_id = $2 AND sender.left_at IS NULL`, [groupId, actorId, recipientId]);
    if (!rowCount || recipientId === actorId) throw unavailable();
    const debt = (await readDebts(db, [groupId], actorId)).find((d) => d.userId === recipientId && d.cents < 0);
    if (!debt || !Number.isSafeInteger(debt.cents)) throw unavailable();
    const { rowCount: pending } = await db.query(`SELECT 1 FROM settlements WHERE group_id = $1
      AND payer_user_id = $2 AND payee_user_id = $3 AND status = 'pending' LIMIT 1`, [groupId, recipientId, actorId]);
    if (pending) throw new HttpError(409, 'PAYMENT_PENDING', 'This person already has a payment pending.');
    if (expenseId) {
      const { rowCount: expense } = await db.query(`SELECT 1 FROM expenses e JOIN expense_shares s ON s.expense_id = e.id
        WHERE e.id = $1 AND e.group_id = $2 AND e.created_by = $3 AND e.status = 'confirmed'
          AND s.user_id = $4 AND s.share_cents > 0`, [expenseId, groupId, actorId, recipientId]);
      if (!expense) throw unavailable();
    }
    return -debt.cents;
  }
  async function draft({ actor, body }) {
    if (!body || Object.keys(body).some((k) => !['groupId','recipientUserId','expenseId','requestKey'].includes(k)) ||
      ![body.groupId, body.recipientUserId, body.requestKey].every((v) => typeof v === 'string' && UUID.test(v)) ||
      (body.expenseId != null && (typeof body.expenseId !== 'string' || !UUID.test(body.expenseId)))) throw invalid('Choose a group debt and reminder recipient.');
    body = { ...body, groupId: body.groupId.toLowerCase(), recipientUserId: body.recipientUserId.toLowerCase(), requestKey: body.requestKey.toLowerCase(), expenseId: body.expenseId?.toLowerCase() ?? null };
    return withTransaction(async (db) => {
      await db.query('SELECT id FROM users WHERE id = $1 FOR NO KEY UPDATE', [actor.userId]);
      await db.query('SELECT id FROM groups WHERE id = $1 FOR UPDATE', [body.groupId]);
      const { rows: [replay] } = await db.query(`SELECT id, group_id, recipient_user_id, expense_id FROM debt_reminders
        WHERE sender_user_id = $1 AND request_key = $2`, [actor.userId, body.requestKey]);
      if (replay) {
        if (replay.group_id !== body.groupId || replay.recipient_user_id !== body.recipientUserId || replay.expense_id !== (body.expenseId ?? null)) throw new HttpError(409, 'REQUEST_KEY_REUSED', 'Use a new key for different reminder details.');
        return { type: 'reminder_draft', reminder: await read(db, actor.userId, replay.id) };
      }
      const { rows: [quota] } = await db.query(`SELECT count(*)::int AS recent FROM (SELECT 1 FROM debt_reminders WHERE sender_user_id = $1 AND created_at > clock_timestamp() - interval '1 minute' LIMIT 30) r`, [actor.userId]);
      if (quota.recent >= 30) throw new HttpError(429, 'REMINDER_RATE_LIMIT', 'Wait before creating more reminder drafts.');
      const amount = await canonical(db, actor.userId, body.groupId, body.recipientUserId, body.expenseId);
      const { rows: [saved] } = await db.query(`INSERT INTO debt_reminders
        (sender_user_id, recipient_user_id, group_id, expense_id, amount_cents, request_key)
        VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [actor.userId, body.recipientUserId, body.groupId, body.expenseId ?? null, amount, body.requestKey]);
      return { type: 'reminder_draft', reminder: await read(db, actor.userId, saved.id) };
    });
  }
  return {
    async prepare(actor, hints, requestKey) {
      const { rows: groups } = await query(`SELECT g.id, g.name FROM groups g JOIN group_members m ON m.group_id = g.id
        WHERE m.user_id = $1 AND m.left_at IS NULL ORDER BY g.created_at, g.id`, [actor.userId]);
      const selected = hints.groupHint ? groups.filter((g) => normalized(g.name) === normalized(hints.groupHint)) : groups;
      const debts = await readDebts({ query }, selected.map((g) => g.id), actor.userId);
      const eligible = debts.filter((d) => d.cents < 0 && (!hints.participantNames.length || hints.participantNames.some((n) =>
        normalized(n) === normalized(d.displayName) || normalized(n) === normalized(d.displayName).split(/\s+/u)[0])));
      if (eligible.some((d) => !Number.isSafeInteger(d.cents))) throw new HttpError(409, 'DEBT_STATE_INVALID', 'Refresh your debts before sending a reminder.');
      // One bounded candidate read, regardless of the number of group debts.
      // Confirmation still recomputes the authoritative debt under the group lock.
      const candidateQuery = `SELECT e.group_id AS "groupId", g.name AS "groupName",
        owed."userId" AS "recipientUserId", u.display_name AS "recipientName", e.id AS "expenseId",
        e.merchant, -owed.cents AS "amountCents"
        FROM jsonb_to_recordset($2::jsonb) AS owed("groupId" uuid, "userId" uuid, cents bigint)
        JOIN groups g ON g.id = owed."groupId"
        JOIN expenses e ON e.group_id = g.id AND e.created_by = $1 AND e.status = 'confirmed'
        JOIN expense_shares s ON s.expense_id = e.id AND s.user_id = owed."userId" AND s.share_cents > 0
        JOIN users u ON u.id = owed."userId"
        JOIN group_members sender ON sender.group_id = g.id AND sender.user_id = $1 AND sender.left_at IS NULL
        JOIN group_members recipient ON recipient.group_id = g.id AND recipient.user_id = u.id AND recipient.left_at IS NULL
        WHERE ($3::text IS NULL OR position(lower($3) in lower(e.merchant)) > 0)
          AND NOT EXISTS (SELECT 1 FROM settlements pending WHERE pending.group_id = g.id
            AND pending.payer_user_id = u.id AND pending.payee_user_id = $1 AND pending.status = 'pending')
        ORDER BY e.confirmed_at DESC, e.id, u.id LIMIT 6`;
      const args = [actor.userId, JSON.stringify(eligible.map(({ groupId, userId, cents }) => ({ groupId, userId, cents }))), hints.merchant];
      let { rows: candidates } = await query(candidateQuery, args);
      const needsChoice = !candidates.length && !!hints.merchant;
      // A food nickname may not match the bank merchant. Offer explicit
      // authorized choices instead of guessing that an unrelated charge fits.
      if (needsChoice) ({ rows: candidates } = await query(candidateQuery, [...args.slice(0, 2), null]));
      if (candidates.length === 1 && !needsChoice) return draft({ actor, body: { groupId: candidates[0].groupId,
        recipientUserId: candidates[0].recipientUserId, expenseId: candidates[0].expenseId, requestKey } });
      return { type: 'reminder_selection', candidates, requestKey,
        answer: candidates.length ? needsChoice ? 'No expense matched that description. Choose the related expense and group debt explicitly.' : 'Choose the person and group debt, then review a reminder.' : 'No matching unpaid debt is available to remind. Check the person, expense and group.' };
    },
    'reminders.draft': draft,
    async 'reminders.confirm'({ actor, params, body }) {
      if (!UUID.test(params.id) || !body || Object.keys(body).length) throw invalid('Confirm only the reviewed reminder.');
      try { return await withTransaction(async (db) => {
        const preview = await read(db, actor.userId, params.id);
        await db.query('SELECT id FROM groups WHERE id = $1 FOR UPDATE', [preview.groupId]);
        await db.query('SELECT id FROM debt_reminders WHERE id = $1 FOR UPDATE', [params.id]);
        const reminder = await read(db, actor.userId, params.id);
        if (reminder.status === 'sent') return { type: 'reminder_sent', reminder };
        if (new Date(reminder.expiresAt) <= new Date()) throw new HttpError(409, 'REMINDER_EXPIRED', 'This reminder expired. Create a new review.');
        const amount = await canonical(db, actor.userId, reminder.groupId, reminder.recipientUserId, reminder.expenseId);
        if (amount !== reminder.amountCents) throw new HttpError(409, 'DEBT_CHANGED', 'This debt changed. Review a new reminder before sending.');
        await db.query(`UPDATE debt_reminders SET status = 'sent', sent_on = (clock_timestamp() AT TIME ZONE 'America/New_York')::date WHERE id = $1`, [params.id]);
        await notify(db, { kind: 'debt_reminder', sourceId: params.id });
        return { type: 'reminder_sent', reminder: await read(db, actor.userId, params.id) };
      }); } catch (e) {
        if (e.code === '23505' && e.constraint === 'debt_reminders_daily_idx') throw new HttpError(429, 'REMINDER_DAILY_LIMIT', 'You already reminded this person about this group debt today.');
        throw e;
      }
    },
  };
}
