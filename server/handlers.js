// Feature handler registry: one line per slice. createApp() rejects any name
// that is not in routes.js. Keep imports alphabetical to avoid merge conflicts.
import { createIntentParser } from './assistant/gemini-intent.js';
import { createAskWorkflow } from './assistant/workflow.js';
import { bankingHandlers } from './banking/handlers.js';

import { getPool, withTransaction } from './db/pool.js';
import { createLedgerHandlers } from './ledger/handlers.js';

export const handlers = Object.freeze({
  'ask.create': createAskWorkflow({
    parseIntent: createIntentParser({ apiKey: process.env.GEMINI_API_KEY, model: process.env.GEMINI_MODEL }),
    query: (...args) => getPool().query(...args), withTransaction,
  }),
  ...bankingHandlers,
  ...createLedgerHandlers({ query: (...args) => getPool().query(...args), withTransaction }),
});
