// B3 · Spending and earnings buckets with TimescaleDB time_bucket.
//
// Rules:
//   - spending  = purchases only (transfers never count, in or out)
//   - earnings  = deposits only
//   - declined and cancelled rows never count; pending ones do
//   - buckets are in the app's local time zone, zero-filled across the whole
//     requested range, and every number reconciles to bank_transactions rows
//     (recent entries carry the bucket they fall in).
//   - account.spendableCents is B4's figure: available after goal and
//     pending settlement holds. That is the number users see as available.
import { getSpendableFunds } from './funds.js';

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
const IN_RANGE = `
  account_id = $1
  AND occurred_at >= ($2::date::timestamp AT TIME ZONE '${TIME_ZONE}')
  AND occurred_at <  (($3::date + 1)::timestamp AT TIME ZONE '${TIME_ZONE}')`;
const COUNTS = `status IN ('pending', 'completed')`;

/** The overview for one bank account over a validated range. */
export async function getOverview(db, accountId, range, { recentLimit = 25 } = {}) {
  const interval = BUCKETS[range.bucket];
  const params = [accountId, range.from, range.to, interval];

  const account = await db.query(
    `SELECT a.id, a.nickname, a.account_mask AS mask, a.balance_cents AS "balanceCents",
            a.available_cents AS "availableCents", a.balance_as_of AS "balanceAsOf"
       FROM bank_accounts a WHERE a.id = $1`,
    [accountId],
  );

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
              coalesce(sum(amount_cents) FILTER (WHERE kind = 'deposit'), 0)  AS earned,
              coalesce(sum(amount_cents) FILTER (WHERE kind = 'purchase'), 0) AS spent,
              count(*) FILTER (WHERE kind IN ('deposit', 'purchase'))         AS n
         FROM bank_transactions
        WHERE ${IN_RANGE} AND ${COUNTS}
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

  const recent = await db.query(
    `SELECT id, provider_transaction_id AS "providerTransactionId", kind, direction,
            amount_cents AS "amountCents", description, merchant_name AS "merchantName",
            category, payment_method AS "paymentMethod", status, source,
            occurred_at AS "occurredAt",
            to_char(greatest(time_bucket($4::interval, occurred_at AT TIME ZONE '${TIME_ZONE}'), $2::date::timestamp), 'YYYY-MM-DD') AS "bucketStart",
            CASE WHEN status NOT IN ('pending', 'completed') THEN null
                 WHEN kind = 'purchase' THEN 'spent'
                 WHEN kind = 'deposit' THEN 'earned' END AS "countsAs"
       FROM bank_transactions
      WHERE ${IN_RANGE}
      ORDER BY occurred_at DESC, id
      LIMIT $5`,
    [...params, recentLimit],
  );

  // Purchases in range, grouped for Profile (categories, methods, merchants).
  const merchants = await db.query(
    `SELECT coalesce(merchant_name, description) AS name,
            coalesce(category, 'Other') AS category,
            coalesce(payment_method, 'Card') AS "paymentMethod",
            sum(amount_cents)::bigint AS cents, count(*)::int AS count
       FROM bank_transactions
      WHERE ${IN_RANGE} AND ${COUNTS} AND kind = 'purchase'
      GROUP BY 1, 2, 3
      ORDER BY cents DESC, name`,
    params.slice(0, 3),
  );

  const funds = account.rows.length ? await getSpendableFunds(accountId, db) : null;

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
    range: { from: range.from, to: range.to, bucket: range.bucket, timeZone: TIME_ZONE },
    totals: {
      earnedCents: rows.reduce((a, b) => a + b.earnedCents, 0),
      spentCents: rows.reduce((a, b) => a + b.spentCents, 0),
    },
    buckets: rows,
    recent: recent.rows,
    breakdown: {
      categories: sumBy('category'),
      paymentMethods: sumBy('paymentMethod'),
      merchants: merchants.rows,
    },
    sync: { lastSyncedAt: account.rows[0]?.balanceAsOf ?? null },
  };
}

/** The account owned by a user (mapped or not), or null. */
export async function accountIdForUser(db, userId) {
  const { rows } = await db.query('SELECT id FROM bank_accounts WHERE user_id = $1', [userId]);
  return rows[0]?.id ?? null;
}
