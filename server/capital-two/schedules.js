import { randomUUID } from 'node:crypto';
import { HttpError } from '../http.js';
import { ownedAccount } from './accounts.js';
import { fields, invalid, monthDate, nextMonthly, scheduleInput, today, uuid } from './input.js';

export const scheduleColumns = `id, account_id AS "accountId", payee, amount_cents AS "amountCents",
  day_of_month AS "dayOfMonth", next_due_on::text AS "nextDueOn", status, created_at AS "createdAt"`;

export function createSchedules({ query, withTransaction, operations, now = () => new Date() }) {
  async function enqueue(id, userId, manual = false) {
    return withTransaction(async (db) => {
      const { rows: [schedule] } = await db.query(`SELECT ${scheduleColumns}
        FROM capital_schedules WHERE id = $1 AND user_id = $2 FOR UPDATE`, [id, userId]);
      if (!schedule) throw new HttpError(404, 'BANK_SCHEDULE_NOT_FOUND', 'Payment schedule not found.');
      if (manual && schedule.status === 'completed' && !schedule.dayOfMonth) {
        return (await db.query('SELECT id FROM capital_operations WHERE schedule_id = $1 AND user_id = $2', [id, userId])).rows[0]?.id;
      }
      if (schedule.status !== 'active') throw new HttpError(409, 'BANK_SCHEDULE_INACTIVE', 'This payment schedule is not active.');
      const date = today(now());
      if (!manual && schedule.nextDueOn > date) return null;
      const occurrence = schedule.dayOfMonth ? (manual ? date : schedule.nextDueOn).slice(0, 7) : schedule.nextDueOn;
      const { rows: [inserted] } = await db.query(`INSERT INTO capital_operations
        (user_id, account_id, kind, payee, amount_cents, request_key, schedule_id, occurrence)
        VALUES ($1, $2, 'purchase', $3, $4, $5, $6, $7)
        ON CONFLICT (schedule_id, occurrence) DO NOTHING RETURNING id`,
      [userId, schedule.accountId, schedule.payee, schedule.amountCents, randomUUID(), id, occurrence]);
      const operation = inserted ?? (await db.query(`SELECT id FROM capital_operations WHERE schedule_id = $1 AND occurrence = $2`, [id, occurrence])).rows[0];
      // Run now consumes this calendar month's occurrence, not each click.
      // A late worker pays the oldest due occurrence once, then resumes the
      // next future date; it never batches years of missed charges at restart.
      if (!manual || schedule.nextDueOn.slice(0, 7) <= occurrence.slice(0, 7)) {
        if (schedule.dayOfMonth) {
          const [year, month] = date.split('-').map(Number);
          const anchor = manual ? monthDate(year, month - 1, 31) : date;
          await db.query(`UPDATE capital_schedules SET next_due_on = $2,
            updated_at = clock_timestamp() WHERE id = $1`, [id, nextMonthly(anchor, schedule.dayOfMonth)]);
        }
        else await db.query("UPDATE capital_schedules SET status = 'completed', updated_at = clock_timestamp() WHERE id = $1", [id]);
      }
      return operation.id;
    });
  }
  return {
    enqueue,
    async create(userId, body) {
      const input = scheduleInput(body, today(now()));
      return withTransaction(async (db) => {
        await ownedAccount(db, userId, input.accountId);
        const { rows: [inserted] } = await db.query(`INSERT INTO capital_schedules
          (user_id, account_id, payee, amount_cents, day_of_month, next_due_on, request_key)
          VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (user_id, request_key) DO NOTHING RETURNING ${scheduleColumns}`,
        [userId, input.accountId, input.payee, input.amountCents, input.dayOfMonth, input.dueOn, input.requestKey]);
        if (inserted && input.dueOn < today(now())) throw invalid('Choose today or a future payment date.');
        const schedule = inserted ?? (await db.query(`SELECT ${scheduleColumns} FROM capital_schedules
          WHERE user_id = $1 AND request_key = $2`, [userId, input.requestKey])).rows[0];
        if (schedule.accountId !== input.accountId || schedule.payee !== input.payee || schedule.amountCents !== input.amountCents ||
            schedule.dayOfMonth !== input.dayOfMonth || (!input.dayOfMonth && schedule.nextDueOn !== input.dueOn)) {
          throw new HttpError(409, 'BANK_KEY_REUSED', 'This retry key belongs to a different payment schedule.');
        }
        return schedule;
      });
    },
    async update(userId, id, body) {
      fields(body, ['action']);
      const status = { pause: 'paused', resume: 'active', delete: 'deleted' }[body.action];
      if (!status) throw invalid();
      return withTransaction(async (db) => {
        const { rows: [schedule] } = await db.query(`SELECT ${scheduleColumns} FROM capital_schedules WHERE id = $1 AND user_id = $2 FOR UPDATE`, [uuid(id), userId]);
        if (!schedule) throw new HttpError(404, 'BANK_SCHEDULE_NOT_FOUND', 'Payment schedule not found.');
        if (['deleted', 'completed'].includes(schedule.status) && schedule.status !== status) throw new HttpError(409, 'BANK_SCHEDULE_INACTIVE', 'This payment schedule has ended.');
        const nextDue = status === 'active' && schedule.dayOfMonth ? nextMonthly(today(now()), schedule.dayOfMonth, true) : schedule.nextDueOn;
        const { rows: [updated] } = await db.query(`UPDATE capital_schedules SET status = $3, next_due_on = $4,
          updated_at = clock_timestamp() WHERE id = $1 AND user_id = $2 RETURNING ${scheduleColumns}`, [id, userId, status, nextDue]);
        if (['paused', 'deleted'].includes(status)) await db.query(`UPDATE capital_operations SET status = 'cancelled',
          failure_code = 'schedule_paused', updated_at = clock_timestamp() WHERE schedule_id = $1 AND user_id = $2 AND status = 'queued'`, [id, userId]);
        return updated;
      });
    },
    async run(userId, id, body) {
      fields(body, []);
      const operationId = await enqueue(uuid(id), userId, true);
      return operations.process(operationId, userId);
    },
    async due() {
      const { rows } = await query(`SELECT id, user_id AS "userId" FROM capital_schedules
        WHERE status = 'active' AND next_due_on <= $1::date ORDER BY next_due_on, id LIMIT 5`, [today(now())]);
      for (const row of rows) {
        try { await enqueue(row.id, row.userId); } catch (error) { if (error.code !== 'BANK_SCHEDULE_INACTIVE') throw error; }
      }
    },
  };
}
