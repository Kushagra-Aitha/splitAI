import { HttpError } from '../http.js';
import { createIntentParser } from './gemini-intent.js';
import { validateMessage } from './intent.js';

export function createAskHandler({ parseIntent }) {
  return async ({ body }) => {
    // Only the message reaches the model. Session tokens, actor/account IDs,
    // query fields, provider credentials, and client context are excluded.
    const parsed = await parseIntent(validateMessage(body));
    if (parsed.intent === 'expense') {
      const missingFields = [];
      if (parsed.expense.merchant === null) missingFields.push('merchant');
      if (parsed.expense.cents === null) missingFields.push('cents');
      if (!parsed.expense.participantNames.length) missingFields.push('participantNames');
      return {
        type: 'selection_needed',
        intent: 'expense',
        reason: missingFields.length ? 'EXPENSE_DETAILS_REQUIRED' : 'GROUP_AND_MEMBERS_REQUIRED',
        extraction: parsed.expense,
        missingFields,
      };
    }
    if (parsed.intent === 'payment_clarification') {
      return {
        type: 'answer',
        intent: 'payment_clarification',
        answer: 'No expense or payment was created. Did someone else pay and you want to settle a debt, or did you pay and want to split a purchase?',
      };
    }
    if (parsed.intent === 'unsupported') {
      return {
        type: 'answer',
        intent: 'unsupported',
        answer: 'Ask about one expense or a financial question at a time. Review payments separately with Settle up.',
      };
    }
    // C4 supplies actor-scoped facts and read services. Never fabricate an
    // affordability, debt, or insight answer from a model classification.
    throw new HttpError(501, 'ASSISTANT_FACTS_UNAVAILABLE', 'This financial question is not available yet. No changes were made.');
  };
}

export function createAssistantHandlers(options) {
  return { 'ask.create': createAskHandler({ parseIntent: createIntentParser(options) }) };
}
