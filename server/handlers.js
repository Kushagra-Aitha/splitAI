import { HttpError } from './http.js';
import { createElevenLabs } from './assistant/elevenlabs.js';
import { createVoiceLimit } from './assistant/voice-limit.js';
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
const voice = createElevenLabs({ apiKey: process.env.ELEVENLABS_API_KEY, voiceId: process.env.ELEVENLABS_VOICE_ID });
const limitVoice = createVoiceLimit();
const transcribeVoice = createVoiceTranscription(generate, { transcribe: voice.transcribe, limit: limitVoice });

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
  'ask.transcribe': transcribeVoice,
  'voice.transcribe': transcribeVoice,
  'voice.speak': async ({ actor, body }) => {
    const text = typeof body?.text === 'string' ? body.text.trim() : '';
    if (!text || text.length > 600) {
      throw new HttpError(422, 'INVALID_VOICE_TEXT', 'Send up to 600 characters to read aloud.');
    }
    limitVoice(actor.userId);
    try { return await voice.speak(text); } catch { return null; }
  },
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
