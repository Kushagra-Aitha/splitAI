// B3 acceptance: day, week and month views match the source rows, and
// changing the period changes the data. Rebuilds every bucket in plain JS
// from raw bank_transactions rows and compares with the time_bucket query.
import { TIME_ZONE, getOverview, parseRange } from '../banking/overview.js';
import { ACCOUNTS } from '../db/demo-ids.js';
import { closePool, getPool } from '../db/pool.js';

const db = getPool();
const accountId = ACCOUNTS.maya;
const localDate = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE }).format(d);

function bucketOf(date, size) {
  if (size === 'day') return date;
  if (size === 'month') return `${date.slice(0, 8)}01`;
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); // back to Monday
  return d.toISOString().slice(0, 10);
}

async function expected(range) {
  const { rows } = await db.query(
    `SELECT kind, status, amount_cents AS cents, occurred_at FROM bank_transactions WHERE account_id = $1`,
    [accountId],
  );
  const out = new Map();
  for (const r of rows) {
    const date = localDate(r.occurred_at);
    if (date < range.from || date > range.to) continue;
    if (!['pending', 'completed'].includes(r.status) || !['purchase', 'deposit'].includes(r.kind)) continue;
    const start = bucketOf(date, range.bucket);
    const key = start < range.from ? range.from : start;
    const b = out.get(key) ?? { earnedCents: 0, spentCents: 0 };
    if (r.kind === 'deposit') b.earnedCents += r.cents;
    else b.spentCents += r.cents;
    out.set(key, b);
  }
  return out;
}

const cases = [
  { from: '2026-11-01', to: '2026-11-14' },
  { from: '2026-11-01', to: '2026-11-30', bucket: 'week' },
  { from: '2026-06-01', to: '2026-11-14' },
  { from: '2026-10-15', to: '2026-11-14', bucket: 'day' },
];

let failed = false;
const totals = [];
try {
  for (const c of cases) {
    const range = parseRange(c);
    const got = await getOverview(db, accountId, range);
    const want = await expected(range);
    let ok = true;
    for (const b of got.buckets) {
      const w = want.get(b.start) ?? { earnedCents: 0, spentCents: 0 };
      if (w.earnedCents !== b.earnedCents || w.spentCents !== b.spentCents) {
        ok = false;
        console.log(`    bucket ${b.start}: got ${b.earnedCents}/${b.spentCents}, rows say ${w.earnedCents}/${w.spentCents}`);
      }
    }
    const covered = [...want.keys()].every((k) => got.buckets.some((b) => b.start === k));
    ok &&= covered;
    failed ||= !ok;
    totals.push(JSON.stringify(got.totals) + range.bucket + got.buckets.length);
    console.log(
      `  ${ok ? 'PASS' : 'FAIL'}  ${range.from} → ${range.to} by ${range.bucket.padEnd(5)} ` +
        `${String(got.buckets.length).padStart(3)} buckets  earned $${(got.totals.earnedCents / 100).toFixed(2)}  spent $${(got.totals.spentCents / 100).toFixed(2)}`,
    );
  }
  const changes = new Set(totals).size === totals.length;
  failed ||= !changes;
  console.log(`  ${changes ? 'PASS' : 'FAIL'}  changing the period changes the data`);
  console.log(failed ? '\nB3 check: FAILED' : '\nB3 check: OK, every bucket matches the source rows');
} catch (err) {
  failed = true;
  console.error('B3 check failed:', err.message);
} finally {
  await closePool();
  if (failed) process.exitCode = 1;
}
