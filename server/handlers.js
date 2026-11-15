import { createVoiceTranscription } from './assistant/voice-transcription.js';
// Feature handler registry: one line per slice. createApp() rejects any name
// that is not in routes.js. Keep imports alphabetical to avoid merge conflicts.
import { createActivityHandlers } from './activity/handlers.js';
import { createFactExplainer, createFinancialAnswers } from './assistant/answers.js';
import { createIntentParser } from './assistant/gemini-intent.js';
import { createGeminiClient } from './assistant/gemini-json.js';
import { createAskWorkflow } from './assistant/workflow.js';
import { lockAccount, reserveFunds } from './banking/funds.js';
import { bankingHandlers } from './banking/handlers.js';
import { createCapitalService } from './capital-two/service.js';
import { createCapitalHandlers } from './capital-two/handlers.js';

import { getPool, withTransaction } from './db/pool.js';
import { createGoalHandlers } from './goals/handlers.js';
import { createGuardEventsHandler } from './guard/events.js';
import { createGuardSettings } from './guard/settings.js';
import { createSettlementConfirmation } from './ledger/confirm-settlement.js';
import { createChargeExplanation } from './ledger/explain-charge.js';
import { createLedgerHandlers } from './ledger/handlers.js';
import { createRecurringSplits } from './ledger/recurring-splits.js';
import { createSettlementLookup } from './ledger/reconcile-settlements.js';
import { createNotificationHandlers } from './notifications/handlers.js';
import { createInsightsHandler } from './insights/read.js';
import { createReminderHandlers } from './reminders/handlers.js';

const generate = createGeminiClient({ apiKey: process.env.GEMINI_API_KEY, model: process.env.GEMINI_MODEL });
const answerFinancial = createFinancialAnswers({ withTransaction, explain: createFactExplainer({ generate }) });
const db = { query: (...args) => getPool().query(...args), withTransaction };
const recurringSplits = createRecurringSplits(db);
const reminders = createReminderHandlers(db);
const chargeExplanation = createChargeExplanation({ withTransaction, explain: createFactExplainer({ generate }) });
export const capitalService = createCapitalService({ ...db, generateRecurringSplits: recurringSplits.generate });

export const handlers = Object.freeze({
  'insights.get': createInsightsHandler({ withTransaction }),
  ...createCapitalHandlers(capitalService),
  ...recurringSplits.handlers,
  'charges.explain': chargeExplanation.byId,
  ...createActivityHandlers({ withTransaction }),
  'ask.transcribe': createVoiceTranscription(generate),
  'ask.create': createAskWorkflow({
    prepareReminder: reminders.prepare,
    parseIntent: createIntentParser({ generate }),
    query: (...args) => getPool().query(...args), withTransaction, answerFinancial, explainCharge: chargeExplanation.byMerchant,
  }),
  'insight.get': (context) => answerFinancial({ ...context, intent: 'spending_insight' }),
  ...bankingHandlers,
  ...createNotificationHandlers({ query: (...args) => getPool().query(...args) }),
  'reminders.draft': reminders['reminders.draft'],
  'reminders.confirm': reminders['reminders.confirm'],
  'guard.list': createGuardEventsHandler((...args) => getPool().query(...args)),
  ...createGuardSettings({ query: (...args) => getPool().query(...args), withTransaction }),
  ...createGoalHandlers({ query: (...args) => getPool().query(...args), withTransaction }),
  'settlements.get': createSettlementLookup((...args) => getPool().query(...args)),
  'settlementReviews.confirm': createSettlementConfirmation({ withTransaction, lockAccount, reserveFunds }),
  ...createLedgerHandlers({ query: (...args) => getPool().query(...args), withTransaction }),
});
