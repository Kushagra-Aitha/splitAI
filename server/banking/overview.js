import { settlementDescription, settlementLabelJoin } from '../ledger/settlement-labels.js';
// B3 · Spending and earnings buckets with TimescaleDB time_bucket.
//
// Rules:
//   - spending  = purchases, plus settlements (B17): one you paid counts in
//     the category it paid for, one you received reduces it. Other transfers
//     never count, in or out
//   - earnings  = deposits only
//   - declined and cancelled rows never count; pending ones do
//   - buckets are in the app's local time zone, zero-filled across the whole
//     requested range, and every number reconciles to bank_transactions rows
//     (recent entries carry the bucket they fall in).
//   - account.spendableCents is B4's figure: available after goal and
//     pending settlement holds. That is the number users see as available.
import { getSpendableFunds } from './funds.js';
import { effectiveCategory, isSalary, recurringColumns, recurringJoins } from './details.js';
import { displayCategory, settledColumns, settledJoin, spendingLines } from '../ledger/settlement-categories.js';

export const TIME_ZONE = 'America/New_York';
const BUCKETS = { day: '1 day', week: '1 week', month: '1 month' };
const MAX_DAYS = { day: 92, week: 371, month: 731 };
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Raised for a bad from/to/bucket; the handler turns it into a 422. */
export class RangeError422 extends Error {}

function parseDate(value, name) {
  if (typeof value !== 'string' || !DATE.test(value)) {
    throw new RangeError422(`${name} must be a date like 2026-11-01.`);
  }
  const d = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) {
    throw new RangeError422(`${name} is not a real calendar date.`);
  }
  return d;
}

/**
 * Validates a range. `bucket` defaults to day for ranges up to 62 days and
 * month beyond that.
 */
export function parseRange({ from, to, bucket } = {}) {
  const f = parseDate(from, 'from');
  const t = parseDate(to, 'to');
  if (t < f) throw new RangeError422('to must be on or after from.');
  const days = Math.round((t - f) / 86_400_000) + 1;
  const size = bucket ?? (days <= 62 ? 'day' : 'month');
  if (!BUCKETS[size]) throw new RangeError422('bucket must be day, week or month.');
  if (days > MAX_DAYS[size]) {
    throw new RangeError422(`A ${size} view covers at most ${MAX_DAYS[size]} days.`);
  }
  return { from, to, bucket: size, days };
}

// Rows that can count toward the chart, inside [from, to] local dates.
const inRange = (alias = '') => `
  ${alias}account_id = ANY($1::uuid[])
  AND ${alias}occurred_at >= ($2::date::timestamp AT TIME ZONE '${TIME_ZONE}')
  AND ${alias}occurred_at <  (($3::date + 1)::timestamp AT TIME ZONE '${TIME_ZONE}')`;
const IN_RANGE = inRange();
const COUNTS = `status IN ('pending', 'completed')`;
const SPENDING = spendingLines(`${inRange('t.')} AND t.${COUNTS}`);

/**
 * The overview for a user's money over a validated range. `accountId` is the
 * checking account (balance and spendable funds); activity, spending and
 * recent transactions cover every account that user has linked, so credit
 * card purchases count too (B12). Moving money between your own accounts
 * (paying the card) is a transfer and never counts as earned or spent.
 */
/** YYYY-MM-DD: `last` plus the number of days between `previous` and `last`. */
function nextFromGap(previous, last) {
  const day = 86_400_000;
  const gap = Math.round((Date.parse(`${last}T12:00:00Z`) - Date.parse(`${previous}T12:00:00Z`)) / day);
  if (gap < 7 || gap > 40) return null;
  return new Date(Date.parse(`${last}T12:00:00Z`) + gap * day).toISOString().slice(0, 10);
}

export async function getOverview(db, accountId, range, { recentLimit = 25 } = {}) {
  const interval = BUCKETS[range.bucket];

  const account = await db.query(
    `SELECT a.id, a.nickname, a.account_mask AS mask, a.balance_cents AS "balanceCents",
            a.available_cents AS "availableCents", a.balance_as_of AS "balanceAsOf"
       FROM bank_accounts a WHERE a.id = $1`,
    [accountId],
  );
  const { rows: linked } = await db.query(
    `SELECT b.id, b.kind, b.nickname, b.account_mask AS mask, b.balance_cents AS "balanceCents",
            b.available_cents AS "availableCents", b.credit_limit_cents AS "creditLimitCents",
            b.balance_as_of AS "balanceAsOf"
       FROM bank_accounts a JOIN bank_accounts b ON b.user_id = a.user_id
      WHERE a.id = $1 AND (b.id = $1 OR b.linked_at IS NOT NULL)`,
    [accountId],
  );
  const accountIds = linked.map((row) => row.id);
  if (!accountIds.includes(accountId)) accountIds.push(accountId);
  const params = [accountIds, range.from, range.to, interval];
  // What you owe on a card is its limit minus available credit, which also
  // covers purchases that are still pending.
  const cards = linked.filter((row) => row.kind === 'credit_card').map(({ kind, ...card }) => ({
    ...card,
    owedCents: card.creditLimitCents !== null && card.availableCents !== null
      ? Math.max(0, card.creditLimitCents - card.availableCents) : null,
  }));

  // Zero-filled buckets: a generated series of local bucket starts, left
  // joined to time_bucket aggregates over local timestamps.
  const buckets = await db.query(
    `WITH series AS (
       SELECT generate_series(
                time_bucket($4::interval, $2::date::timestamp),
                time_bucket($4::interval, $3::date::timestamp),
                $4::interval) AS start
     ), agg AS (
       SELECT time_bucket($4::interval, occurred_at AT TIME ZONE '${TIME_ZONE}') AS start,
              coalesce(sum(earned), 0) AS earned, coalesce(sum(spent), 0) AS spent, count(DISTINCT id) AS n
         FROM (SELECT id, occurred_at, amount_cents AS earned, 0 AS spent FROM bank_transactions t
                WHERE ${inRange('t.')} AND t.${COUNTS} AND t.kind = 'deposit'
               UNION ALL
               SELECT id, occurred_at, 0, cents FROM ${SPENDING}) activity
        GROUP BY 1
     )
     SELECT to_char(greatest(s.start, $2::date::timestamp), 'YYYY-MM-DD') AS start,
            to_char(least(s.start + $4::interval, ($3::date + 1)::timestamp) - interval '1 day', 'YYYY-MM-DD') AS "end",
            coalesce(a.earned, 0)::bigint AS "earnedCents",
            coalesce(a.spent, 0)::bigint  AS "spentCents",
            coalesce(a.n, 0)::int         AS "transactionCount"
       FROM series s LEFT JOIN agg a USING (start)
      ORDER BY s.start`,
    params,
  );

  // Each row carries what A2/A3 need to split it (accountId + providerKey)
  // and, once split, the group it was split with.
  const recent = await db.query(
    `SELECT t.id, t.provider_transaction_id AS "providerTransactionId", t.kind, t.direction,
            t.amount_cents AS "amountCents", ${settlementDescription} AS description, CASE WHEN settlement_label.label IS NULL THEN t.merchant_name END AS "merchantName",
            ${displayCategory} AS category, t.payment_method AS "paymentMethod", t.status, t.source,
            ${recurringColumns('t')}, ${settledColumns},
            t.occurred_at AS "occurredAt", t.account_id AS "accountId", acct.kind AS "accountKind",
            acct.account_mask AS "accountMask", k.provider_key AS "providerKey",
            g.id AS "splitGroupId", g.name AS "splitGroupName",
            to_char(greatest(time_bucket($4::interval, t.occurred_at AT TIME ZONE '${TIME_ZONE}'), $2::date::timestamp), 'YYYY-MM-DD') AS "bucketStart",
            CASE WHEN t.status NOT IN ('pending', 'completed') THEN null
                 WHEN t.kind = 'purchase' OR (settled.id IS NOT NULL AND t.direction = 'debit') THEN 'spent'
                 WHEN settled.id IS NOT NULL THEN 'reimbursed'
                 WHEN t.kind = 'deposit' THEN 'earned' END AS "countsAs"
       FROM bank_transactions t
       JOIN bank_accounts acct ON acct.id = t.account_id
       LEFT JOIN bank_import_keys k ON k.account_id = t.account_id AND k.transaction_id = t.id AND k.occurred_at = t.occurred_at
       LEFT JOIN expenses e ON e.bank_account_id = t.account_id AND e.bank_provider_key = k.provider_key AND e.status = 'confirmed'
       LEFT JOIN groups g ON g.id = e.group_id
       ${settlementLabelJoin}
       ${settledJoin}
       ${recurringJoins('t', 'k')}
      WHERE ${inRange('t.')}
      ORDER BY t.occurred_at DESC, t.id
      LIMIT $5`,
    [...params, recentLimit],
  );

  // Purchases in range, grouped for Profile (categories, methods, merchants).
  const merchants = await db.query(
    `SELECT coalesce(merchant_name, description) AS name,
            coalesce(${effectiveCategory('bank_transactions')}, 'Other') AS category,
            coalesce(payment_method, 'Card') AS "paymentMethod",
            sum(amount_cents)::bigint AS cents, count(*)::int AS count
       FROM bank_transactions
      WHERE ${IN_RANGE} AND ${COUNTS} AND kind = 'purchase'
      GROUP BY 1, 2, 3
      ORDER BY cents DESC, name`,
    params.slice(0, 3),
  );

  // Where the money went, by category, settlements included (B17).
  const categories = await db.query(
    `SELECT category, sum(cents)::bigint AS cents FROM ${SPENDING} lines
      GROUP BY 1 HAVING sum(cents) > 0 ORDER BY cents DESC, category`,
    params.slice(0, 3),
  );
  const settledTotals = await db.query(
    `SELECT coalesce(sum(cents) FILTER (WHERE cents > 0), 0)::bigint AS "paidCents",
            coalesce(-sum(cents) FILTER (WHERE cents < 0), 0)::bigint AS "receivedCents"
       FROM ${SPENDING} lines WHERE settled`,
    params.slice(0, 3),
  );

  const funds = account.rows.length ? await getSpendableFunds(accountId, db) : null;
  const { rows: goalReservations } = await db.query(`SELECT g.id, g.name, g.saved_cents AS "savedCents"
    FROM goals g JOIN bank_accounts a ON a.id = g.account_id
    WHERE a.id = $1 AND g.user_id = a.user_id AND g.saved_cents > 0
    ORDER BY g.created_at, g.id`, [accountId]);

  // Salary (B15): the latest paychecks across linked accounts; the next one is
  // estimated from the gap between the last two (never invented from one).
  const { rows: paychecks } = await db.query(
    `SELECT t.amount_cents AS "amountCents", t.description, op.payee,
            to_char(t.occurred_at AT TIME ZONE '${TIME_ZONE}', 'YYYY-MM-DD') AS "paidOn"
       FROM bank_transactions t
       LEFT JOIN bank_import_keys k ON k.account_id = t.account_id AND k.transaction_id = t.id AND k.occurred_at = t.occurred_at
       LEFT JOIN capital_operations op ON op.account_id = t.account_id AND op.provider_reference = k.provider_key
      WHERE t.account_id = ANY($1::uuid[]) AND ${isSalary('t')} AND t.status IN ('pending', 'completed')
      ORDER BY t.occurred_at DESC LIMIT 2`,
    [accountIds],
  );
  // C13's direct deposit schedule gives the exact next date; otherwise it is
  // estimated from the gap between the last two paychecks.
  const { rows: [schedule] } = await db.query(
    `SELECT s.payee, s.amount_cents AS "amountCents", to_char(s.next_due_on, 'YYYY-MM-DD') AS "nextDueOn"
       FROM capital_schedules s JOIN bank_accounts a ON a.id = s.account_id
      WHERE a.id = ANY($1::uuid[]) AND s.kind = 'salary' AND s.status = 'active'
      ORDER BY s.next_due_on LIMIT 1`,
    [accountIds],
  );
  const last = paychecks[0];
  const salary = last || schedule ? {
    amountCents: last?.amountCents ?? schedule.amountCents,
    employer: last?.payee ?? schedule?.payee ?? (last?.description.replace(/^(payroll|salary|direct deposit)\s*[·:-]?\s*/i, '') || null),
    lastPaidOn: last?.paidOn ?? null,
    nextPaidOn: schedule?.nextDueOn ?? (paychecks.length > 1 ? nextFromGap(paychecks[1].paidOn, last.paidOn) : null),
    nextIsScheduled: Boolean(schedule),
  } : null;

  const sumBy = (key) => {
    const m = new Map();
    for (const r of merchants.rows) m.set(r[key], (m.get(r[key]) ?? 0) + r.cents);
    return [...m].map(([k, cents]) => ({ [key]: k, cents })).sort((a, b) => b.cents - a.cents);
  };

  const rows = buckets.rows;
  return {
    account: account.rows[0]
      ? {
          ...account.rows[0],
          goalHoldsCents: funds.goalHoldsCents,
          settlementHoldsCents: funds.settlementHoldsCents,
          spendableCents: funds.spendableCents,
        }
      : null,
    cards,
    goalReservations,
    salary,
    range: { from: range.from, to: range.to, bucket: range.bucket, timeZone: TIME_ZONE },
    totals: {
      earnedCents: rows.reduce((a, b) => a + b.earnedCents, 0),
      spentCents: rows.reduce((a, b) => a + b.spentCents, 0),
    },
    buckets: rows,
    settledWithSplit: settledTotals.rows[0],
    recent: recent.rows,
    breakdown: {
      categories: categories.rows,
      paymentMethods: sumBy('paymentMethod'),
      merchants: merchants.rows,
    },
    sync: { lastSyncedAt: account.rows[0]?.balanceAsOf ?? null },
  };
}

/**
 * The user's linked checking account, or null. Overview, spendable funds,
 * goals and Ask's facts all start from it; null means "connect your bank".
 */
export async function accountIdForUser(db, userId) {
  const { rows } = await db.query(
    `SELECT id FROM bank_accounts WHERE user_id = $1 AND kind = 'checking' AND linked_at IS NOT NULL`,
    [userId],
  );
  return rows[0]?.id ?? null;
}
