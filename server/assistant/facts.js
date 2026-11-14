import { accountIdForUser, getOverview, parseRange, RangeError422, TIME_ZONE } from '../banking/overview.js';
import { getSpendableFunds } from '../banking/funds.js';
import { readDebts } from '../ledger/debts.js';
import { HttpError } from '../http.js';

const invalidState = () => new HttpError(409, 'FINANCIAL_STATE_INVALID', 'These financial facts need a refresh before Split can explain them.');

// Shared DB helpers parse bigint as Number. Fail closed before any unsafe
// integer reaches an explanation or JSON response, including aggregate sums.
export function validateFactAmounts(value, key = '') {
  if (Array.isArray(value)) return value.forEach((item) => validateFactAmounts(item, key));
  if (value && typeof value === 'object') {
    for (const [name, item] of Object.entries(value)) validateFactAmounts(item, name);
  } else if (/cents$/i.test(key) && value !== null && !Number.isSafeInteger(value)) {
    throw invalidState();
  }
}

export function insightRange(query = new URLSearchParams(), now = new Date()) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE }).format(now);
  try {
    return parseRange({
      from: query.get('from') ?? `${today.slice(0, 8)}01`,
      to: query.get('to') ?? today,
      bucket: query.get('bucket') ?? undefined,
    });
  } catch (error) {
    if (error instanceof RangeError422) throw new HttpError(422, 'INVALID_RANGE', error.message);
    throw error;
  }
}

export async function readFinancialFacts({ withTransaction, actorId, query, now = new Date() }) {
  const range = insightRange(query, now);
  return withTransaction(async (db) => {
    // No locks or mutations: all component reads share one MVCC snapshot.
    // Finish this transaction before asking a model to explain the facts.
    await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const accountId = await accountIdForUser(db, actorId);
    if (!accountId) throw new HttpError(409, 'NO_LINKED_ACCOUNT', 'Your demo bank account isn’t connected yet.');
    const { rows: groups } = await db.query(`
      SELECT g.id, g.name, g.kind, g.created_at AS "createdAt"
      FROM groups g JOIN group_members m ON m.group_id = g.id
      WHERE m.user_id = $1 ORDER BY g.created_at, g.id`, [actorId]);
    const debts = await readDebts(db, groups.map((group) => group.id), actorId);
    const funds = await getSpendableFunds(accountId, db);
    // Hold-backed payments are already reserved in B4's spendable figure.
    // Expose them separately so the plan can avoid proposing the same debt;
    // never subtract these holds from spendable a second time.
    const { rows: heldPayments } = await db.query(`
      SELECT id, group_id AS "groupId", payee_user_id AS "payeeUserId",
        amount_cents::text AS "amountCents", hold_cents::text AS "holdCents", status
      FROM settlements WHERE payer_account_id = $1 AND payer_user_id = $2 AND hold_cents > 0
      ORDER BY created_at, id`, [accountId, actorId]);
    const overview = await getOverview(db, accountId, range);
    const snapshot = {
      asOf: now.toISOString(), currency: 'USD', funds, groups, debts,
      heldPayments: heldPayments.map((payment) => ({ ...payment,
        amountCents: Number(payment.amountCents), holdCents: Number(payment.holdCents),
      })),
      spending: { range: overview.range, totals: overview.totals,
        breakdown: overview.breakdown, buckets: overview.buckets },
    };
    validateFactAmounts(snapshot);
    return snapshot;
  });
}
