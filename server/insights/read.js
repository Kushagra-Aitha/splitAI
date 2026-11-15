import { HttpError } from '../http.js';
import { TIME_ZONE } from '../banking/overview.js';
import { isSalary, recurringJoins } from '../banking/details.js';
import { listGoals } from '../goals/read.js';
import { spendingLines } from '../ledger/settlement-categories.js';
import { readDebts } from '../ledger/debts.js';
import { progressForGoal } from '../assistant/goal-progress.js';
import { monthDate, today, addDays } from '../capital-two/input.js';
import { cardAmountDue, nextStatementDueDate } from '../banking/card-due.js';

const invalid = () => new HttpError(409, 'INSIGHTS_STATE_INVALID', 'These totals are outside the supported range.');
export function exactCents(value) {
  if (typeof value !== 'string' || !/^-?\d+$/u.test(value)) throw invalid();
  const n = Number(value); if (!Number.isSafeInteger(n)) throw invalid(); return n;
}
const roundedDivide = (value, divisor) => Number((BigInt(value) + BigInt(divisor) / 2n) / BigInt(divisor));
export function buildAllocation(monthly, categories, goals) {
  const total = (rows, key) => exactCents(String(rows.reduce((sum, row) => sum + BigInt(row[key]), 0n)));
  const salaryCents = total(monthly, 'salaryCents');
  const spendingCents = total(categories, 'totalCents');
  const goalReservationCents = total(goals, 'savedCents');
  const allocatedCents = exactCents(String(BigInt(spendingCents) + BigInt(goalReservationCents)));
  return {
    salaryCents,
    spendingCents,
    goalReservationCents,
    unallocatedSalaryCents: salaryCents > allocatedCents ? exactCents(String(BigInt(salaryCents) - BigInt(allocatedCents))) : 0,
    outsideSalaryCents: allocatedCents > salaryCents ? exactCents(String(BigInt(allocatedCents) - BigInt(salaryCents))) : 0,
    note: 'Allocation view only. Goal savings remain in checking and are not bank outflows.',
  };
}
export function insightsWindow(now = new Date()) {
  const to = today(now), [year, month] = to.split('-').map(Number);
  const months = Array.from({ length: 12 }, (_, i) => monthDate(year, month - 12 + i, 1).slice(0, 7));
  return { from: `${months[0]}-01`, to, months, timeZone: TIME_ZONE };
}
const counted = "t.status IN ('pending', 'completed')";
const inRange = `t.account_id = ANY($1::uuid[]) AND ${counted}
  AND t.occurred_at >= ($2::date::timestamp AT TIME ZONE '${TIME_ZONE}')
  AND t.occurred_at < (($3::date + 1)::timestamp AT TIME ZONE '${TIME_ZONE}')`;
const monthSQL = `to_char(t.occurred_at AT TIME ZONE '${TIME_ZONE}', 'YYYY-MM')`;
// B17: purchases plus settlements (paid counts, received reduces spending).
const lines = spendingLines(inRange);
const lineMonth = `to_char(l.occurred_at AT TIME ZONE '${TIME_ZONE}', 'YYYY-MM')`;

export function createInsightsHandler({ withTransaction, now = () => new Date() }) {
  return async ({ actor }) => {
    const at = now(), range = insightsWindow(at), currentMonth = range.to.slice(0, 7);
    return withTransaction(async (db) => {
      await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const { rows: accounts } = await db.query(`SELECT id, kind, account_mask AS mask,
        balance_cents::text AS "balanceCents", available_cents::text AS "availableCents",
        credit_limit_cents::text AS "creditLimitCents", statement_due_day AS "statementDueDay" FROM bank_accounts
        WHERE user_id = $1 AND linked_at IS NOT NULL ORDER BY kind, id`, [actor.userId]);
      const args = [accounts.map((a) => a.id), range.from, range.to];
      const { rows } = await db.query(`SELECT ${monthSQL} AS month,
        coalesce(sum(t.amount_cents) FILTER (WHERE t.kind = 'deposit' AND t.direction = 'credit'), 0)::text AS "earnedCents",
        coalesce(sum(t.amount_cents) FILTER (WHERE ${isSalary()}), 0)::text AS "salaryCents",
        count(*) FILTER (WHERE t.source = 'demo')::int AS "demoCount", count(*)::int AS count
        FROM bank_transactions t WHERE ${inRange} AND t.kind IN ('purchase', 'deposit')
        GROUP BY 1 ORDER BY 1`, args);
      const { rows: spentRows } = await db.query(`SELECT ${lineMonth} AS month, sum(l.cents)::text AS cents
        FROM ${lines} l GROUP BY 1`, args);
      const monthly = range.months.map((month) => {
        const row = rows.find((r) => r.month === month);
        const spent = spentRows.find((r) => r.month === month);
        const earnedCents = exactCents(row?.earnedCents ?? '0'), spentCents = Math.max(0, exactCents(spent?.cents ?? '0'));
        return { month, earnedCents, spentCents, netCents: exactCents(String(BigInt(earnedCents) - BigInt(spentCents))),
          salaryCents: exactCents(row?.salaryCents ?? '0'), count: row?.count ?? 0, demoCount: row?.demoCount ?? 0 };
      });
      const { rows: daily } = await db.query(`SELECT
        to_char(activity.occurred_at AT TIME ZONE '${TIME_ZONE}', 'YYYY-MM-DD') AS day,
        sum(activity.earned)::text AS "earnedCents", sum(activity.spent)::text AS "spentCents"
        FROM (
          SELECT t.occurred_at, t.amount_cents AS earned, 0 AS spent FROM bank_transactions t
          WHERE ${inRange} AND t.kind = 'deposit' AND t.direction = 'credit'
          UNION ALL
          SELECT l.occurred_at, 0, l.cents FROM ${lines} l
        ) activity GROUP BY 1 ORDER BY 1`, [args[0], `${currentMonth}-01`, range.to]);
      // Averages use prior calendar months with recorded activity. Missing
      // historical data is not treated as evidence of zero spending.
      const baselineMonths = monthly.filter((m) => m.month !== currentMonth && m.count > 0).length;
      const { rows: categoryRows } = await db.query(`SELECT l.category,
        sum(l.cents)::text AS "totalCents",
        greatest(0, coalesce(sum(l.cents) FILTER (WHERE ${lineMonth} = $4), 0))::text AS "currentCents",
        greatest(0, coalesce(sum(l.cents) FILTER (WHERE ${lineMonth} <> $4), 0))::text AS "priorCents"
        FROM ${lines} l
        GROUP BY 1 HAVING sum(l.cents) > 0 ORDER BY sum(l.cents) DESC, 1 LIMIT 100`, [...args, currentMonth]);
      const { rows: [settled] } = await db.query(`SELECT
        coalesce(sum(l.cents) FILTER (WHERE l.cents > 0), 0)::text AS "paidCents",
        coalesce(-sum(l.cents) FILTER (WHERE l.cents < 0), 0)::text AS "receivedCents",
        coalesce(sum(l.cents) FILTER (WHERE l.cents > 0 AND ${lineMonth} = $4), 0)::text AS "currentPaidCents",
        coalesce(-sum(l.cents) FILTER (WHERE l.cents < 0 AND ${lineMonth} = $4), 0)::text AS "currentReceivedCents",
        count(DISTINCT l.id)::int AS count
        FROM ${lines} l WHERE l.settled`, [...args, currentMonth]);
      const settledWithSplit = Object.fromEntries(Object.entries(settled).map(([key, value]) =>
        [key, key === 'count' ? value : exactCents(value)]));
      const categories = categoryRows.map((r) => ({ category: r.category, totalCents: exactCents(r.totalCents),
        currentCents: exactCents(r.currentCents), averageCents: baselineMonths ? roundedDivide(r.priorCents, baselineMonths) : null }));
      const { rows: merchantRows } = await db.query(`SELECT coalesce(t.merchant_name, t.description, 'Unknown merchant') AS name,
        sum(t.amount_cents)::text AS cents, count(*)::int AS count
        FROM bank_transactions t WHERE ${inRange} AND t.kind = 'purchase' AND t.direction = 'debit'
        GROUP BY 1 ORDER BY sum(t.amount_cents) DESC, 1 LIMIT 100`, args);
      const merchants = merchantRows.map((r) => ({ ...r, cents: exactCents(r.cents) }));
      const { rows: recurringRows } = await db.query(`WITH activity AS (
        SELECT ${monthSQL} AS month, coalesce(rec_schedule.payee, t.merchant_name, t.description, 'Recurring payment') AS name,
          t.amount_cents AS cents, CASE WHEN rec_op.kind = 'purchase' AND rec_op.schedule_id IS NOT NULL
            THEN 'scheduled' ELSE 'detected' END AS kind
        FROM bank_transactions t
        LEFT JOIN bank_import_keys k ON k.account_id = t.account_id AND k.transaction_id = t.id AND k.occurred_at = t.occurred_at
        ${recurringJoins()}
        WHERE ${inRange} AND t.direction = 'debit' AND t.kind IN ('purchase', 'bill_payment')
          AND (rec_op.kind = 'purchase' AND rec_op.schedule_id IS NOT NULL OR rec_prior.found)
      ), leaders AS (SELECT name FROM activity GROUP BY name ORDER BY sum(cents) DESC, name LIMIT 20)
      SELECT a.month, a.name, a.kind, sum(a.cents)::text AS cents FROM activity a JOIN leaders l ON l.name = a.name
      GROUP BY a.month, a.name, a.kind ORDER BY a.month, a.name, a.kind`, args);
      const recurring = recurringRows.map((r) => ({ ...r, cents: exactCents(r.cents) }));
      const { rows: schedules } = await db.query(`SELECT s.id, s.payee, s.amount_cents::text AS cents,
        s.day_of_month AS day, s.next_due_on::text AS "nextDueOn", s.kind, s.frequency, s.category,
        r.id AS "ruleId", g.name AS "groupName"
        FROM capital_schedules s
        LEFT JOIN recurring_split_rules r ON r.schedule_id = s.id AND r.payer_id = $1 AND NOT r.paused
        LEFT JOIN groups g ON g.id = r.group_id
        WHERE s.user_id = $1 AND s.account_id = ANY($2::uuid[])
          AND s.status = 'active' ORDER BY s.next_due_on, s.id LIMIT 100`, [actor.userId, args[0]]);
      const [year, month] = range.to.split('-').map(Number), calendarEnd = addDays(range.to, 90);
      const dueDays = new Map();
      const addDueItem = (date, item) => {
        if (date < range.to || date > calendarEnd) return;
        const old = dueDays.get(date) ?? { date, cents: 0, count: 0, billCents: 0, incomeCents: 0, items: [] };
        if (item.direction === 'credit') old.incomeCents = exactCents(String(BigInt(old.incomeCents) + BigInt(item.cents)));
        else old.billCents = exactCents(String(BigInt(old.billCents) + BigInt(item.cents)));
        old.cents = exactCents(String(BigInt(old.billCents) + BigInt(old.incomeCents)));
        old.items.push(item); old.count = old.items.length;
        dueDays.set(date, old);
      };
      for (const schedule of schedules) {
        const cents = exactCents(schedule.cents);
        const item = {
          id: schedule.id,
          kind: schedule.kind === 'salary' ? 'salary' : schedule.ruleId ? 'recurring_split' : 'payment',
          name: schedule.ruleId ? `${schedule.payee} · ${schedule.groupName}` : schedule.payee,
          cents,
          source: 'capital_two',
          direction: schedule.kind === 'salary' ? 'credit' : 'debit',
        };
        if (!schedule.day) {
          if (schedule.kind === 'salary' && schedule.frequency === 'biweekly') {
            for (let date = schedule.nextDueOn; date <= calendarEnd; date = addDays(date, 14)) addDueItem(date, item);
          } else addDueItem(schedule.nextDueOn, item);
          continue;
        }
        for (let i = 0; i <= 3; i++) {
          const date = monthDate(year, month - 1 + i, schedule.day);
          if (date >= schedule.nextDueOn) addDueItem(date, item);
        }
      }
      const { rows: reminders } = await db.query(`SELECT r.id, r.sender_user_id AS "senderUserId",
        r.group_id AS "groupId", r.sent_on::text AS date, r.amount_cents::text AS cents,
        coalesce(e.merchant, g.name) AS name, g.name AS "groupName"
        FROM debt_reminders r JOIN groups g ON g.id = r.group_id
        LEFT JOIN expenses e ON e.id = r.expense_id
        WHERE r.recipient_user_id = $1 AND r.status = 'sent'
          AND r.sent_on BETWEEN $2::date AND $3::date
        ORDER BY r.sent_on, r.id LIMIT 100`, [actor.userId, range.to, calendarEnd]);
      const reminderDebts = reminders.length
        ? await readDebts(db, [...new Set(reminders.map((reminder) => reminder.groupId))], actor.userId)
        : [];
      for (const reminder of reminders.filter((item) =>
        reminderDebts.some((debt) => debt.groupId === item.groupId && debt.userId === item.senderUserId && debt.cents > 0))) addDueItem(reminder.date, {
        id: reminder.id, kind: 'group_debt',
        name: `${reminder.name} · ${reminder.groupName}`,
        cents: exactCents(reminder.cents), source: 'split', direction: 'debit',
      });
      const cards = accounts.filter((a) => a.kind === 'credit_card').map((a) => {
        const limit = a.creditLimitCents === null ? null : exactCents(a.creditLimitCents);
        const available = a.availableCents === null ? null : exactCents(a.availableCents);
        const amountDueCents = cardAmountDue({ creditLimitCents: limit, availableCents: available });
        return { id: a.id, mask: a.mask, limitCents: limit, availableCents: available,
          usedCents: amountDueCents, amountDueCents,
          dueDate: nextStatementDueDate(a.statementDueDay, range.to) };
      });
      for (const card of cards) if (card.dueDate && card.amountDueCents > 0) addDueItem(card.dueDate, {
        id: card.id, kind: 'card_statement', name: `Capital Two ••${card.mask || '••••'} statement`,
        cents: card.amountDueCents, source: 'capital_two', direction: 'debit',
      });
      const upcomingSchedules = schedules.filter((schedule) =>
        schedule.nextDueOn >= range.to && schedule.nextDueOn <= calendarEnd).map((schedule) => ({
        id: schedule.id, name: schedule.payee, cents: exactCents(schedule.cents),
        nextDueOn: schedule.nextDueOn, kind: schedule.kind, frequency: schedule.frequency,
        category: schedule.category, recurring: schedule.kind === 'salary' || schedule.day !== null,
      }));
      const { goals } = await listGoals(db, actor.userId);
      const progress = goals.slice(0, 20).map((goal) => {
        const g = progressForGoal(goal, at);
        const days = g.paceCentsPerDay ? Math.ceil(g.remainingCents / g.paceCentsPerDay) : null;
        return { ...g, projectedDate: days !== null && days <= 36525 ? addDays(range.to, days) : null };
      });
      const allocation = buildAllocation(monthly, categories, progress);
      return { range, asOf: at.toISOString(), connected: accounts.length > 0, monthly,
        daily: daily.map((row) => ({ day: row.day, earnedCents: exactCents(row.earnedCents), spentCents: exactCents(row.spentCents) })),
        categories, baselineMonths,
        merchants, recurring, upcomingSchedules,
        calendar: { from: range.to, to: calendarEnd, today: range.to,
          days: [...dueDays.values()].sort((a, b) => a.date.localeCompare(b.date)) },
        goals: progress, goalCount: goals.length, cards, allocation, settledWithSplit,
        limits: { categories: 100, merchants: 100, recurringMerchants: 20, goals: 20, schedules: 100 },
        hasActivity: monthly.some((m) => m.count > 0), hasDemoHistory: monthly.some((m) => m.demoCount > 0) };
    });
  };
}
