// HTTP handlers for the banking slice. The actor always comes from the
// session; nothing in the body selects an account.
import { HttpError } from '../http.js';
import { getPool, withTransaction } from '../db/pool.js';
import { NessieError } from '../lib/nessie.js';
import { RangeError422, TIME_ZONE, accountIdForUser, getOverview, parseRange } from './overview.js';
import { listBills } from './bills.js';
import { linkBankAccounts, listBankAccounts, provisionBankAccount } from './provision.js';
import { syncForUser } from './sync.js';
import { listTransactions } from './transactions.js';

/** Today's date in the app time zone, as YYYY-MM-DD. */
function localToday(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE }).format(now);
}

function providerUnavailable() {
  return new HttpError(
    502,
    'PROVIDER_UNAVAILABLE',
    'We couldn’t reach the bank sandbox. Your saved activity is unchanged; try again in a moment.',
  );
}

// Only provider and network failures map to 502; DB errors stay 500.
async function withProvider(work) {
  try {
    return await work();
  } catch (err) {
    if (err instanceof NessieError || err?.name === 'TimeoutError' ||
        (err instanceof TypeError && err.message === 'fetch failed')) {
      throw providerUnavailable();
    }
    throw err;
  }
}

function syncResponse(result) {
  return {
    account: {
      id: result.accountId,
      balanceCents: result.balanceCents,
      availableCents: result.availableCents,
      balanceAsOf: result.balanceAsOf,
    },
    imported: result.inserted,
    updated: result.updated,
    unchanged: result.unchanged,
    changed: Boolean(result.changed),
  };
}

export const bankingHandlers = {
  'banking.transactions': ({ actor, query }) => listTransactions(getPool(), actor.userId, query),
  /** POST /api/banking/sync → refresh the actor's balance and activity. */
  'banking.sync': async ({ actor }) => {
    const result = await withProvider(() => syncForUser(getPool(), actor.userId));
    if (!result) {
      throw new HttpError(409, 'NO_LINKED_ACCOUNT', 'Your bank account isn’t connected yet.');
    }
    return syncResponse(result);
  },

  /** GET /api/banking/accounts (B12) → the Connect screen and account menu. */
  'banking.accounts': async ({ actor }) => listBankAccounts(getPool(), actor.userId),

  /**
   * POST /api/banking/connect (B9/B12) → the Connect screen's Allow. Opens any
   * missing Capital Two account (checking, card), links them all to Split,
   * then syncs. Safe to repeat: never opens a second account of a kind.
   */
  'banking.connect': async ({ actor }) => {
    const { accounts } = await withProvider(() => provisionBankAccount({ withTransaction }, actor.userId));
    await withTransaction((db) => linkBankAccounts(db, actor.userId));
    const result = await withProvider(() => syncForUser(getPool(), actor.userId));
    return {
      created: accounts.some((account) => account.created),
      ...syncResponse(result),
      ...(await listBankAccounts(getPool(), actor.userId)),
    };
  },

  /**
   * GET /api/overview?from=YYYY-MM-DD&to=YYYY-MM-DD[&bucket=day|week|month]
   * Defaults to the current month so far.
   */
  'overview.get': async ({ actor, query }) => {
    const today = localToday();
    let range;
    try {
      range = parseRange({
        from: query.get('from') ?? `${today.slice(0, 8)}01`,
        to: query.get('to') ?? today,
        bucket: query.get('bucket') ?? undefined,
      });
    } catch (err) {
      if (err instanceof RangeError422) throw new HttpError(422, 'INVALID_RANGE', err.message);
      throw err;
    }
    const db = getPool();
    const accountId = await accountIdForUser(db, actor.userId);
    if (!accountId) {
      throw new HttpError(409, 'NO_LINKED_ACCOUNT', 'Your demo bank account isn’t connected yet.');
    }
    const [overview, bills] = await Promise.all([
      getOverview(db, accountId, range),
      listBills(db, actor.userId, today),
    ]);
    return { ...overview, today, bills };
  },
};
