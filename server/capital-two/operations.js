import { NessieError } from '../lib/nessie.js';
import { HttpError } from '../http.js';
import { ownedAccount } from './accounts.js';
import { operationInput, uuid } from './input.js';

export const operationColumns = `id, account_id AS "accountId", kind, payee, amount_cents AS "amountCents",
  status, schedule_id AS "scheduleId", occurrence, failure_code AS "failureCode", created_at AS "createdAt", updated_at AS "updatedAt"`;
const terminal = new Set(['completed', 'declined', 'cancelled']);
const definitive = (error) => error instanceof NessieError && [400, 401, 403, 404, 422, 429].includes(error.status);
const reference = (operation) => `Capital Two ${operation.payee} [${operation.id}]`;
const matches = (transaction, operation, source, destination) => transaction?.payer_id === source &&
  transaction.amount_cents === operation.amountCents && transaction.description === reference(operation) &&
  transaction.kind === (operation.kind === 'card_payment' ? 'transfer' : operation.kind) &&
  (operation.kind !== 'card_payment' || transaction.payee_id === destination);

export function createOperations({ query, withTransaction, nessie }) {
  const read = async (id, userId) => {
    const { rows: [operation] } = await query(`SELECT ${operationColumns}, provider_reference AS reference,
      claimed_at AS "claimedAt" FROM capital_operations WHERE id = $1 AND user_id = $2`, [id, userId]);
    if (!operation) throw new HttpError(404, 'BANK_OPERATION_NOT_FOUND', 'Payment not found.');
    return operation;
  };
  const publicOperation = ({ reference: ignored, claimedAt, userId: ignoredActor, ...operation }) => operation;

  async function merchant(name) {
    return withTransaction(async (db) => {
      // Stable per-name coordination covers processes as well as concurrent tabs.
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`capital-merchant:${name}`]);
      const { rows: [stored] } = await db.query('SELECT provider_id FROM capital_merchants WHERE name = $1', [name]);
      if (stored) return stored.provider_id;
      let cursor = null, found, pages = 0;
      do {
        const params = new URLSearchParams({ limit: '100', ...(cursor ? { cursor } : {}) });
        const { data } = await nessie(`/merchants?${params}`);
        found = data.items?.find((item) => item.name === name);
        cursor = data.next_cursor || null;
        if (++pages > 20) throw new Error('Merchant listing incomplete.');
      } while (!found && cursor);
      if (!found) ({ data: found } = await nessie('/merchants', { method: 'POST', retries: 0,
        body: { name, category: name === 'Rent' ? 'Housing' : 'Other' } }));
      if (typeof found?.id !== 'string' || !found.id) throw new Error('Invalid merchant.');
      await db.query('INSERT INTO capital_merchants (name, provider_id) VALUES ($1, $2)', [name, found.id]);
      return found.id;
    });
  }

  async function capture(operation, transaction, source, destination) {
    if (!matches(transaction, operation, source, destination) || typeof transaction.id !== 'string' || !transaction.id ||
        !['pending', 'completed', 'declined', 'cancelled'].includes(transaction.status)) throw new Error('Invalid bank transaction.');
    await query(`UPDATE capital_operations SET provider_reference = $3, status = $4,
      failure_code = CASE WHEN $4 = 'declined' THEN 'bank_declined' WHEN $4 = 'cancelled' THEN 'bank_cancelled' ELSE NULL END,
      updated_at = clock_timestamp() WHERE id = $1 AND user_id = $2
      AND status IN ('submitting', 'unknown', 'pending') AND (provider_reference IS NULL OR provider_reference = $3)`,
    [operation.id, operation.userId, transaction.id, transaction.status]);
  }

  async function process(id, userId) {
    let operation = await read(id, userId);
    if (terminal.has(operation.status)) return publicOperation(operation);
    const source = await ownedAccount({ query }, userId, operation.accountId);
    let destination = null;
    if (operation.kind === 'card_payment') {
      const { rows: [card] } = await query(`SELECT provider_account_id AS reference FROM bank_accounts
        WHERE user_id = $1 AND account_type = 'Credit Card' AND provider_account_id IS NOT NULL`, [userId]);
      if (source.type !== 'Checking' || !card) throw new HttpError(409, 'CARD_NOT_CONNECTED', 'Connect checking and your credit card first.');
      destination = card.reference;
    }
    let merchantId;
    // Resolving a merchant cannot move money and can be repeated safely.
    if (operation.status === 'queued' && operation.kind === 'purchase') merchantId = await merchant(operation.payee);
    const { rowCount: claimed } = await query(`UPDATE capital_operations SET status = 'submitting',
      claimed_at = clock_timestamp(), updated_at = clock_timestamp()
      WHERE id = $1 AND user_id = $2 AND status = 'queued'`, [id, userId]);
    operation = { ...await read(id, userId), userId };
    if (terminal.has(operation.status)) return publicOperation(operation);
    let transaction;
    if (claimed) {
      try {
        const kind = operation.kind === 'card_payment' ? 'transfers' : `${operation.kind}s`;
        const { data } = await nessie(`/accounts/${encodeURIComponent(source.reference)}/${kind}`, {
          method: 'POST', retries: 0, body: { amount_cents: operation.amountCents, description: reference(operation),
            ...(merchantId ? { merchant_id: merchantId } : {}), ...(destination ? { payee_id: destination } : {}) },
        });
        transaction = data;
      } catch (error) {
        await query(`UPDATE capital_operations SET status = $3, failure_code = $4, updated_at = clock_timestamp()
          WHERE id = $1 AND user_id = $2 AND status = 'submitting'`,
        [id, userId, definitive(error) ? 'declined' : 'unknown', definitive(error) ? 'bank_rejected' : 'verification_required']);
        return publicOperation(await read(id, userId));
      }
    } else if (operation.reference) {
      ({ data: transaction } = await nessie(`/transactions/${encodeURIComponent(operation.reference)}`));
    } else {
      // Another request may still be sending. A later recovery looks for the
      // exact operation reference, never amount/name alone and never resends.
      if (operation.status === 'submitting' && Date.now() - new Date(operation.claimedAt).getTime() < 30_000) return publicOperation(operation);
      await query('UPDATE capital_operations SET updated_at = clock_timestamp() WHERE id = $1 AND user_id = $2', [id, userId]);
      const { data } = await nessie(`/accounts/${encodeURIComponent(source.reference)}/transactions?limit=5000`);
      const found = (data.items ?? []).filter((tx) => matches(tx, operation, source.reference, destination));
      if (found.length !== 1) return publicOperation(operation);
      [transaction] = found;
    }
    await capture(operation, transaction, source.reference, destination);
    if (transaction.status === 'pending') {
      try {
        const { data } = await nessie(`/transactions/${encodeURIComponent(transaction.id)}/settle`, { method: 'POST', retries: 0 });
        await capture(operation, data, source.reference, destination);
      } catch { /* Creation is durable; retries reconcile/settle this ID only. */ }
    }
    return publicOperation(await read(id, userId));
  }

  return {
    process,
    async get(id, userId) { return publicOperation(await read(uuid(id), userId)); },
    async create(userId, body) {
      const input = operationInput(body);
      const operation = await withTransaction(async (db) => {
        const account = await ownedAccount(db, userId, input.accountId);
        if (input.kind === 'card_payment' && account.type !== 'Checking') throw new HttpError(422, 'CHECKING_REQUIRED', 'Pay your card from checking.');
        await db.query('SELECT id FROM users WHERE id = $1 FOR NO KEY UPDATE', [userId]);
        const { rows: [replay] } = await db.query(`SELECT ${operationColumns} FROM capital_operations WHERE user_id = $1 AND request_key = $2`, [userId, input.requestKey]);
        const checkReplay = (existing) => {
          if (existing.accountId !== input.accountId || existing.kind !== input.kind || existing.payee !== input.payee || existing.amountCents !== input.amountCents) {
            throw new HttpError(409, 'BANK_KEY_REUSED', 'This retry key belongs to a different payment.');
          }
          return existing;
        };
        if (replay) return checkReplay(replay);
        if (input.kind === 'card_payment') {
          const card = await db.query("SELECT 1 FROM bank_accounts WHERE user_id = $1 AND account_type = 'Credit Card' AND provider_account_id IS NOT NULL", [userId]);
          if (!card.rowCount) throw new HttpError(409, 'CARD_NOT_CONNECTED', 'Connect your credit card first.');
        }
        const { rows: [quota] } = await db.query(`SELECT
          (SELECT count(*)::int FROM (SELECT 1 FROM capital_operations WHERE user_id = $1
            AND created_at > clock_timestamp() - interval '1 minute' LIMIT 30) recent) AS recent,
          (SELECT count(*)::int FROM (SELECT 1 FROM capital_operations WHERE user_id = $1
            AND status IN ('queued', 'submitting', 'unknown', 'pending') LIMIT 100) unresolved) AS unresolved`, [userId]);
        if (quota.recent >= 30 || quota.unresolved >= 100) throw new HttpError(429, 'BANK_RATE_LIMITED', 'Please wait before creating more payments. Existing payments can still be recovered.');
        const { rows: [inserted] } = await db.query(`INSERT INTO capital_operations
          (user_id, account_id, kind, payee, amount_cents, request_key) VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT (user_id, request_key) DO NOTHING RETURNING ${operationColumns}`,
        [userId, input.accountId, input.kind, input.payee, input.amountCents, input.requestKey]);
        const existing = inserted ?? (await db.query(`SELECT ${operationColumns} FROM capital_operations
          WHERE user_id = $1 AND request_key = $2`, [userId, input.requestKey])).rows[0];
        return checkReplay(existing);
      });
      return process(operation.id, userId);
    },
  };
}
