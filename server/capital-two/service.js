import { nessie as defaultNessie } from '../lib/nessie.js';
import { HttpError } from '../http.js';
import { normalizeTransaction } from '../banking/provider.js';
import { persistActivity } from '../banking/sync.js';
import { ensureAccounts } from './accounts.js';
import { createOperations, operationColumns } from './operations.js';
import { createSchedules, scheduleColumns } from './schedules.js';

const presets = Object.freeze([
  { payee: "Domino's", amountCents: 2400 }, { payee: 'Amazon', amountCents: 4600 },
  { payee: 'Delta flight', amountCents: 38900 }, { payee: 'Whole Foods', amountCents: 6200 },
  { payee: 'Uber', amountCents: 1800 }, { payee: 'Rent', amountCents: 160000 },
]);

export function createCapitalService({ query, withTransaction, nessie = defaultNessie, now, generateRecurringSplits }) {
  const dependencies = { query, withTransaction, nessie };
  const operations = createOperations(dependencies);
  const schedules = createSchedules({ ...dependencies, operations, now });
  const syncs = new Map();
  const run = schedules.run;
  schedules.run = async (...args) => {
    const operation = await run(...args);
    // Keep the accepted payment response even if draft generation needs a worker retry.
    if (generateRecurringSplits) await generateRecurringSplits(operation.id).catch(() => {});
    return operation;
  };

  async function sync(userId) {
    if (syncs.has(userId)) return syncs.get(userId);
    // Shared promise prevents one user's tab/focus/action refreshes from
    // fetching the same provider accounts concurrently.
    const request = (async () => {
      const { rows: accounts } = await query(`SELECT id, provider_account_id AS reference FROM bank_accounts
        WHERE user_id = $1 AND provider = 'nessie' AND provider_account_id IS NOT NULL
          AND account_type IN ('Checking', 'Credit Card') ORDER BY id`, [userId]);
      const { rows: merchants } = await query('SELECT name, provider_id FROM capital_merchants');
      const names = new Map(merchants.map((merchant) => [merchant.provider_id, { name: merchant.name, category: merchant.name === 'Rent' ? 'Housing' : 'Other' }]));
      for (const account of accounts) {
        const path = `/accounts/${encodeURIComponent(account.reference)}`;
        const { data: activity } = await nessie(`${path}/transactions?limit=100`);
        const { data: balance } = await nessie(path);
        if (balance.id !== account.reference || !Number.isSafeInteger(balance.balance_cents) || !Number.isSafeInteger(balance.available_cents)) throw new Error('Invalid bank snapshot.');
        const transactions = (activity.items ?? []).map((tx) => normalizeTransaction(tx, account.reference, names)).filter(Boolean);
        const snapshot = { balance: { balanceCents: balance.balance_cents, availableCents: balance.available_cents,
          accountType: balance.type, accountMask: String(balance.account_number ?? '').slice(-4) || null, balanceAsOf: new Date().toISOString() },
        transactions, skipped: (activity.items ?? []).length - transactions.length };
        await withTransaction(async (db) => {
          await persistActivity(db, account.id, snapshot);
          if (balance.type === 'Credit Card' && Number.isSafeInteger(balance.credit_limit_cents) && balance.credit_limit_cents > 0) {
            await db.query('UPDATE bank_accounts SET credit_limit_cents = $2 WHERE id = $1', [account.id, balance.credit_limit_cents]);
          }
        });
      }
    })();
    syncs.set(userId, request);
    try { await request; } finally { syncs.delete(userId); }
  }

  return {
    operations, schedules,
    async connect(userId) { await ensureAccounts(dependencies, userId); await sync(userId); return this.summary(userId); },
    async sync(userId) {
      try { await sync(userId); } catch { throw new HttpError(502, 'BANK_UNAVAILABLE', 'The bank could not be fully refreshed. Showing the last saved activity; try again.'); }
      return this.summary(userId);
    },
    async summary(userId) {
      const results = await Promise.all([
        query(`SELECT id, account_type AS type, kind, linked_at IS NOT NULL AS "sharedWithSplit", account_mask AS mask, balance_cents AS "balanceCents",
          available_cents AS "availableCents", credit_limit_cents AS "creditLimitCents", balance_as_of AS "asOf",
          provider_account_id IS NOT NULL AS connected FROM bank_accounts WHERE user_id = $1
          AND account_type IN ('Checking', 'Credit Card') ORDER BY account_type`, [userId]),
        query(`SELECT ${scheduleColumns} FROM capital_schedules WHERE user_id = $1 AND status <> 'deleted' ORDER BY next_due_on, id LIMIT 100`, [userId]),
        query(`SELECT ${operationColumns} FROM capital_operations WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT 30`, [userId]),
        query(`SELECT t.id, t.account_id AS "accountId", t.kind, t.direction, t.amount_cents AS "amountCents", t.status,
          t.merchant_name AS merchant, regexp_replace(t.description, ' \\[[0-9a-f-]{36}\\]$', '') AS description, t.occurred_at AS "occurredAt"
          FROM bank_transactions t JOIN bank_accounts a ON a.id = t.account_id
          WHERE a.user_id = $1 AND t.source = 'nessie' ORDER BY t.occurred_at DESC, t.id DESC LIMIT 40`, [userId]),
      ]);
      const data = { accounts: results[0].rows, schedules: results[1].rows, operations: results[2].rows, transactions: results[3].rows, presets };
      // Reject unsafe integers before exposing balances or amounts to the UI.
      const validate = (value, key = '') => {
        if (Array.isArray(value)) return value.forEach((item) => validate(item, key));
        if (value && typeof value === 'object') return Object.entries(value).forEach(([name, item]) => validate(item, name));
        if (/Cents$/.test(key) && value !== null && !Number.isSafeInteger(value)) throw new HttpError(409, 'BANK_STATE_INVALID', 'The bank snapshot needs to be refreshed.');
      };
      validate(data); return data;
    },
    async tick() {
      await schedules.due();
      const { rows } = await query(`SELECT id, user_id AS "userId" FROM capital_operations
        WHERE status IN ('queued', 'submitting', 'unknown', 'pending')
          AND (status = 'queued' OR updated_at < clock_timestamp() - interval '30 seconds')
        ORDER BY (status = 'queued') DESC, updated_at, id LIMIT 5`);
      for (const row of rows) {
        try { await operations.process(row.id, row.userId); } catch { /* Retain durable operation for a later recovery. */ }
      }
      await generateRecurringSplits?.();
    },
  };
}
