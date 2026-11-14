// B4 · The single serialized funds operation.
//
//   spendable = provider available − goal holds − settlement holds
//
// - provider available: the last synced Nessie `available_cents` (balance
//   minus Nessie's own pending debits); falls back to `balance_cents`.
// - goal holds: sum of goals.saved_cents for the account (C5 maintains it).
// - settlement holds: sum of settlements.hold_cents where this account pays
//   (A7 sets the hold when claiming; A8 sets it back to 0 on release).
//
// Every operation that changes any of these three numbers (balance refresh,
// goal contribution or withdrawal, settlement claim or finalization) runs
// inside one DB transaction that first takes the bank_accounts row lock via
// lockAccount(). Two reservations against one account therefore run one
// after the other, and the second one sees the first one's hold.
//
// Ownership (Funds handoff): B4 owns this calculation and the lock; C5 owns
// goal balances and movement rows; A7 owns settlement status and hold fields.
import { withTransaction } from '../db/pool.js';

/** 409: the reservation would spend money that is not available. */
export class InsufficientFundsError extends Error {
  constructor(requestedCents, spendableCents) {
    super(`Requested ${requestedCents} cents but only ${spendableCents} cents are spendable.`);
    this.code = 'INSUFFICIENT_FUNDS';
    this.status = 409;
    this.requestedCents = requestedCents;
    this.spendableCents = spendableCents;
  }
}

/** 409: no synced balance yet, so nothing can be reserved safely. */
export class BalanceUnknownError extends Error {
  constructor(accountId) {
    super(`Account ${accountId} has no synced balance yet.`);
    this.code = 'BALANCE_UNKNOWN';
    this.status = 409;
  }
}

/** 422: the amount is not a positive integer number of cents. */
export class InvalidAmountError extends Error {
  constructor() {
    super('Amount must be a positive whole number of cents.');
    this.code = 'INVALID_AMOUNT';
    this.status = 422;
  }
}

const accountIdOf = (account) => (typeof account === 'string' ? account : account?.id);

/**
 * Takes the account's row lock for the rest of the current DB transaction.
 * Call it first in any transaction that changes balance, goal holds or
 * settlement holds. `db` must be a client inside BEGIN … COMMIT.
 */
export async function lockAccount(db, account) {
  const id = accountIdOf(account);
  const { rows } = await db.query('SELECT id FROM bank_accounts WHERE id = $1 FOR UPDATE', [id]);
  if (!rows.length) throw new Error(`bank account ${id} not found`);
}

/** Pure arithmetic, shared by reads and reservations. */
export function spendableFrom({ balanceCents, availableCents, goalHoldsCents, settlementHoldsCents }) {
  const providerCents = availableCents ?? balanceCents;
  return providerCents - goalHoldsCents - settlementHoldsCents;
}

async function readFunds(db, accountId) {
  const { rows } = await db.query(
    `SELECT a.id AS "accountId",
            a.balance_cents AS "balanceCents",
            a.available_cents AS "availableCents",
            a.balance_as_of AS "balanceAsOf",
            (SELECT coalesce(sum(g.saved_cents), 0) FROM goals g
              WHERE g.account_id = a.id)::bigint AS "goalHoldsCents",
            (SELECT coalesce(sum(s.hold_cents), 0) FROM settlements s
              WHERE s.payer_account_id = a.id)::bigint AS "settlementHoldsCents"
       FROM bank_accounts a
      WHERE a.id = $1`,
    [accountId],
  );
  if (!rows.length) throw new Error(`bank account ${accountId} not found`);
  const f = rows[0];
  const known = f.balanceCents !== null || f.availableCents !== null;
  return { ...f, spendableCents: known ? spendableFrom(f) : null };
}

/**
 * Spendable funds for an account. With only `account`, it is a consistent
 * read for display. Pass `db` (a client that already holds lockAccount) to
 * read under the lock.
 */
export async function getSpendableFunds(account, db) {
  const id = accountIdOf(account);
  if (db) return readFunds(db, id);
  return withTransaction((tx) => readFunds(tx, id));
}

/**
 * Validates a reservation under the account lock. On success the caller
 * MUST persist its hold (goal saved_cents or settlement hold_cents) in the
 * same transaction, before COMMIT; that write is what the next reservation
 * will see. Throws InvalidAmountError, BalanceUnknownError or
 * InsufficientFundsError; on any throw the caller rolls back.
 */
export async function reserveFunds(dbTx, account, cents) {
  if (!Number.isSafeInteger(cents) || cents <= 0) throw new InvalidAmountError();
  const id = accountIdOf(account);
  await lockAccount(dbTx, id);
  const funds = await readFunds(dbTx, id);
  if (funds.spendableCents === null) throw new BalanceUnknownError(id);
  if (funds.spendableCents < cents) throw new InsufficientFundsError(cents, funds.spendableCents);
  return {
    accountId: id,
    reservedCents: cents,
    spendableBeforeCents: funds.spendableCents,
    spendableAfterCents: funds.spendableCents - cents,
  };
}

/**
 * Convenience for feature code: runs fn(db) in one transaction that already
 * holds the account lock.
 */
export async function withFundsLock(account, fn) {
  return withTransaction(async (db) => {
    await lockAccount(db, account);
    return fn(db);
  });
}
