import { lockAccount, reserveFunds } from './banking/funds.js';
import { createSettlementConfirmation } from './ledger/confirm-settlement.js';
// Feature handler registry: one line per slice. createApp() rejects any name
// that is not in routes.js. Keep imports alphabetical to avoid merge conflicts.
import { bankingHandlers } from './banking/handlers.js';

import { getPool, withTransaction } from './db/pool.js';
import { createLedgerHandlers } from './ledger/handlers.js';

export const handlers = Object.freeze({
  ...bankingHandlers,
  'settlementReviews.confirm': createSettlementConfirmation({ withTransaction, lockAccount, reserveFunds }),
  ...createLedgerHandlers({ query: (...args) => getPool().query(...args), withTransaction }),
});
