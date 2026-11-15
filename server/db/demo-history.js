// Labeled demo history for Maya's account, Jun 1 – Nov 13, 2026.
//
// Nessie stamps every transaction with the current time and cannot backdate,
// so the months before the sandbox existed are seeded here with
// source = 'demo'. Monthly and November totals match the Profile design.
// Rows are deterministic (stable provider keys and IDs), so seeding again
// inserts nothing. Real Nessie activity syncs on top with source = 'nessie'.
import { createHash } from 'node:crypto';

// [month, earned cents, spent cents, days covered]
const MONTHS = [
  ['2026-06', 280000, 248000, 30],
  ['2026-07', 300000, 260000, 31],
  ['2026-08', 276000, 260000, 31],
  ['2026-09', 310000, 278000, 30],
  ['2026-10', 286000, 254000, 31],
  ['2026-11', 102000, 109200, 13],
];

// Fixed monthly costs, on fixed days.
const FIXED = [
  { slug: 'rent', merchant: 'Rent · Puffton Village', category: 'Home & bills', method: 'Bank transfer', cents: 60000, day: 1 },
  { slug: 'utilities', merchant: 'Utilities', category: 'Home & bills', method: 'Bank transfer', cents: 1800, day: 10 },
];

// Everyday spending: November's exact totals; other months scale to fit.
const EVERYDAY = [
  { slug: 'doordash', merchant: 'DoorDash', category: 'Food & drink', method: 'Card', cents: 14000, count: 5 },
  { slug: 'class-supplies', merchant: 'Class supplies', category: 'Other', method: 'Card', cents: 8000, count: 2 },
  { slug: 'concert', merchant: 'Concert tickets', category: 'Just for fun', method: 'Card', cents: 9200, count: 1 },
  { slug: 'campus-cafe', merchant: 'Campus café', category: 'Food & drink', method: 'Card', cents: 5400, count: 12 },
  { slug: 'transit', merchant: 'Transit', category: 'Getting around', method: 'Contactless', cents: 4800, count: 8 },
  { slug: 'trader-joes', merchant: 'Trader Joe’s', category: 'Food & drink', method: 'Card', cents: 4000, count: 3 },
  { slug: 'laundry', merchant: 'Laundry', category: 'Other', method: 'Cash', cents: 2000, count: 4 },
];

// November paychecks match the design; other months are paid on the 1st and 15th.
const NOVEMBER_DEPOSITS = [
  { day: 1, cents: 28000 },
  { day: 5, cents: 27000 },
  { day: 8, cents: 47000 },
];

/** Splits `total` into `n` integer parts that sum exactly; extra cents go first. */
export function splitCents(total, n) {
  const base = Math.floor(total / n);
  return Array.from({ length: n }, (_, i) => base + (i < total - base * n ? 1 : 0));
}

/** Scales `weights` to integer parts that sum exactly to `total`. */
function scale(weights, total) {
  const sum = weights.reduce((a, b) => a + b, 0);
  const parts = weights.map((w) => Math.floor((w * total) / sum));
  parts[parts.length - 1] += total - parts.reduce((a, b) => a + b, 0);
  return parts;
}

/** Deterministic UUID (version 5 layout) from a provider key. */
export function demoId(key) {
  const h = createHash('sha1').update(`split-demo:${key}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h[16], 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

// Noon Eastern (17:00Z in Nov after DST ends, 16:00Z before) plus a few
// minutes per row, so rows on one day are ordered.
function at(month, day, minute) {
  const offsetHours = month >= '2026-11' ? 5 : 4;
  const d = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)) - 1, day, 12 + offsetHours, minute));
  return d.toISOString();
}

/** Every demo row, oldest first, as { providerKey, occurredAt, kind, ... }. */
export function demoHistory() {
  const rows = [];
  for (const [month, earned, spent, days] of MONTHS) {
    const deposits = month === '2026-11'
      ? NOVEMBER_DEPOSITS
      : splitCents(earned, 2).map((cents, i) => ({ day: i ? 15 : 1, cents }));
    deposits.forEach((d, i) => rows.push({
      providerKey: `demo:${month}:paycheck:${i}`,
      occurredAt: at(month, d.day, 0),
      kind: 'deposit', direction: 'credit', amountCents: d.cents,
      description: 'Paycheck · Campus job', merchantName: null, category: 'Income', paymentMethod: 'Direct deposit',
    }));

    for (const f of FIXED) {
      if (f.day > days) continue;
      rows.push({
        providerKey: `demo:${month}:${f.slug}:0`,
        occurredAt: at(month, f.day, 5),
        kind: 'purchase', direction: 'debit', amountCents: f.cents,
        description: f.merchant, merchantName: f.merchant, category: f.category, paymentMethod: f.method,
      });
    }

    const fixedTotal = FIXED.filter((f) => f.day <= days).reduce((a, f) => a + f.cents, 0);
    const totals = scale(EVERYDAY.map((e) => e.cents), spent - fixedTotal);
    EVERYDAY.forEach((e, k) => {
      splitCents(totals[k], e.count).forEach((cents, j) => {
        const day = 1 + ((Math.floor((j * days) / e.count) + k * 2) % days);
        rows.push({
          providerKey: `demo:${month}:${e.slug}:${j}`,
          occurredAt: at(month, day, 10 + k * 3 + j),
          kind: 'purchase', direction: 'debit', amountCents: cents,
          description: e.merchant, merchantName: e.merchant, category: e.category, paymentMethod: e.method,
        });
      });
    });
  }
  return rows.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
}

export const DEMO_MONTH_TOTALS = MONTHS.map(([month, earned, spent]) => ({ month, earned, spent }));

/**
 * Inserts the demo history for one account. Rows already present (same
 * provider key) are skipped, so this is safe to run repeatedly.
 */
export async function insertDemoHistory(db, accountId) {
  let inserted = 0;
  for (const r of demoHistory()) {
    const id = demoId(`${accountId}:${r.providerKey}`);
    const key = await db.query(
      `INSERT INTO bank_import_keys (account_id, provider_key, transaction_id, occurred_at, source)
       VALUES ($1, $2, $3, $4, 'demo')
       ON CONFLICT (account_id, provider_key) DO NOTHING
       RETURNING transaction_id`,
      [accountId, r.providerKey, id, r.occurredAt],
    );
    if (!key.rowCount) continue;
    await db.query(
      `INSERT INTO bank_transactions
         (id, occurred_at, account_id, provider_transaction_id, kind, direction, amount_cents, status,
          description, merchant_name, source, category, payment_method)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'completed', $8, $9, 'demo', $10, $11)`,
      [id, r.occurredAt, accountId, r.providerKey, r.kind, r.direction, r.amountCents,
        r.description, r.merchantName, r.category, r.paymentMethod],
    );
    inserted++;
  }
  return inserted;
}
