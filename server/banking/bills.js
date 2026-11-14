// Recurring costs for Profile (B5), from bill_schedules. Each schedule is
// labeled with its source ('nessie' sandbox bill or 'demo'), and its next due
// date is rolled forward to today or later from its recurrence.

/** YYYY-MM-DD + n months, keeping the day (clamped to the month's length). */
function addMonths(date, n, dayOfMonth) {
  const [y, m] = date.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  first.setUTCDate(Math.min(dayOfMonth, last));
  return first.toISOString().slice(0, 10);
}

function addDays(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** The first occurrence on or after `today`. */
export function nextOccurrence({ nextDueOn, recurrence, dayOfMonth }, today) {
  let due = nextDueOn;
  const day = dayOfMonth ?? Number(nextDueOn.slice(8, 10));
  for (let i = 0; due < today && i < 1000; i++) {
    if (recurrence === 'weekly') due = addDays(due, 7);
    else if (recurrence === 'yearly') due = addMonths(due, 12, day);
    else due = addMonths(due, 1, day);
  }
  return due;
}

export async function listBills(db, userId, today) {
  const { rows } = await db.query(
    `SELECT b.id, b.name, b.amount_cents AS "amountCents", b.is_estimate AS "isEstimate",
            b.recurrence, b.day_of_month AS "dayOfMonth",
            to_char(b.next_due_on, 'YYYY-MM-DD') AS "nextDueOn",
            b.payment_method AS "paymentMethod", b.icon, b.note, b.source,
            b.group_id AS "groupId", g.name AS "groupName"
       FROM bill_schedules b LEFT JOIN groups g ON g.id = b.group_id
      WHERE b.user_id = $1`,
    [userId],
  );
  return rows
    .map(({ dayOfMonth, ...b }) => ({ ...b, nextDueOn: nextOccurrence({ ...b, dayOfMonth }, today) }))
    .sort((a, b) => a.nextDueOn.localeCompare(b.nextDueOn) || b.amountCents - a.amountCents);
}
