// Feature handler registry: one line per slice. createApp() rejects any name
// that is not in routes.js. Keep imports alphabetical to avoid merge conflicts.
import { createAssistantHandlers } from './assistant/ask.js';
import { bankingHandlers } from './banking/handlers.js';

import { getPool, withTransaction } from './db/pool.js';
import { createLedgerHandlers } from './ledger/handlers.js';

export const handlers = Object.freeze({
  ...createAssistantHandlers({ apiKey: process.env.GEMINI_API_KEY, model: process.env.GEMINI_MODEL }),
  ...bankingHandlers,
  ...createLedgerHandlers({ query: (...args) => getPool().query(...args), withTransaction }),
});
