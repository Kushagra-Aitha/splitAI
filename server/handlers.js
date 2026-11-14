// Feature handler registry: one line per slice. createApp() rejects any name
// that is not in routes.js. Keep imports alphabetical to avoid merge conflicts.
import { createFactExplainer, createFinancialAnswers } from './assistant/answers.js';
import { createIntentParser } from './assistant/gemini-intent.js';
import { createGeminiClient } from './assistant/gemini-json.js';
import { createAskWorkflow } from './assistant/workflow.js';
import { lockAccount, reserveFunds } from './banking/funds.js';
import { bankingHandlers } from './banking/handlers.js';

import { getPool, withTransaction } from './db/pool.js';
import { createGoalHandlers } from './goals/handlers.js';
import { createSettlementConfirmation } from './ledger/confirm-settlement.js';
import { createLedgerHandlers } from './ledger/handlers.js';

const generate = createGeminiClient({ apiKey: process.env.GEMINI_API_KEY, model: process.env.GEMINI_MODEL });
const answerFinancial = createFinancialAnswers({ withTransaction, explain: createFactExplainer({ generate }) });

export const handlers = Object.freeze({
  'ask.create': createAskWorkflow({
    parseIntent: createIntentParser({ generate }),
    query: (...args) => getPool().query(...args), withTransaction, answerFinancial,
  }),
  'insight.get': (context) => answerFinancial({ ...context, intent: 'spending_insight' }),
  ...bankingHandlers,
  ...createGoalHandlers({ query: (...args) => getPool().query(...args), withTransaction }),
  'settlementReviews.confirm': createSettlementConfirmation({ withTransaction, lockAccount, reserveFunds }),
  ...createLedgerHandlers({ query: (...args) => getPool().query(...args), withTransaction }),
});
