// HTTP handlers for the banking slice. The actor always comes from the
// session; nothing in the body selects an account.
import { HttpError } from '../http.js';
import { getPool } from '../db/pool.js';
import { NessieError } from '../lib/nessie.js';
import { RangeError422, TIME_ZONE, accountIdForUser, getOverview, parseRange } from './overview.js';
import { syncForUser } from './sync.js';

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

export const bankingHandlers = {
  /** POST /api/banking/sync → refresh the actor's balance and activity. */
  'banking.sync': async ({ actor }) => {
    let result;
    try {
      result = await syncForUser(getPool(), actor.userId);
    } catch (err) {
      // Only provider and network failures map to 502; DB errors stay 500.
      if (err instanceof NessieError || err?.name === 'TimeoutError' ||
          (err instanceof TypeError && err.message === 'fetch failed')) {
        throw providerUnavailable();
      }
      throw err;
    }
    if (!result) {
      throw new HttpError(409, 'NO_LINKED_ACCOUNT', 'Your demo bank account isn’t connected yet.');
    }
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
    return getOverview(db, accountId, range);
  },
};
