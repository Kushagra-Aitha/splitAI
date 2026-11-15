import { HttpError } from '../http.js';
import { answerGoalProgress } from './goal-progress.js';
import { emptyFocus } from './intent.js';

export const ASK_ACTION_TYPES = Object.freeze([
  'transactions', 'spending_guidance', 'explain_charge', 'debt_summary',
  'goal_progress', 'bank_split', 'expense_help',
]);

const CONTROL = /[\p{Cc}\u202a-\u202e\u2066-\u2069]/u;
const PARAMS = {
  transactions: ['type', 'merchant', 'category', 'from', 'to'],
  spending_guidance: ['type', 'category', 'from', 'to'],
  explain_charge: ['type', 'merchant'],
  debt_summary: ['type'],
  goal_progress: ['type'],
  bank_split: ['type', 'merchant', 'groupName'],
  expense_help: ['type', 'groupName'],
};

const invalid = (message = 'Ask action is invalid.') =>
  new HttpError(422, 'INVALID_ASK_ACTION', message);

function textOrNull(value, maxLength) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength || CONTROL.test(value)) {
    throw invalid();
  }
  return value.trim();
}

function dateOrNull(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) throw invalid();
  const date = new Date(`${value}T12:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw invalid();
  return value;
}

/** Validate a chip action. Rejects unknown keys and any financial amounts. */
export function validateAskAction(value) {
  if (value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.type !== 'string') {
    throw invalid();
  }
  if (!ASK_ACTION_TYPES.includes(value.type)) throw invalid('Unknown Ask action.');
  if (Object.hasOwn(value, 'amountCents') || Object.hasOwn(value, 'cents') || Object.hasOwn(value, 'userId')) {
    throw invalid('Ask actions cannot carry amounts or user ids.');
  }
  const allowed = PARAMS[value.type];
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw invalid();
  if (!allowed.every((key) => Object.hasOwn(value, key))) throw invalid();

  switch (value.type) {
    case 'transactions': {
      const action = Object.freeze({
        type: 'transactions',
        merchant: textOrNull(value.merchant, 60),
        category: textOrNull(value.category, 40),
        from: dateOrNull(value.from),
        to: dateOrNull(value.to),
      });
      if (action.from && action.to && action.from > action.to) throw invalid();
      return action;
    }
    case 'spending_guidance': {
      const action = Object.freeze({
        type: 'spending_guidance',
        category: textOrNull(value.category, 40),
        from: dateOrNull(value.from),
        to: dateOrNull(value.to),
      });
      if (action.from && action.to && action.from > action.to) throw invalid();
      return action;
    }
    case 'explain_charge': {
      const merchant = textOrNull(value.merchant, 60);
      if (!merchant) throw invalid('Choose a merchant to explain.');
      return Object.freeze({ type: 'explain_charge', merchant });
    }
    case 'debt_summary':
      return Object.freeze({ type: 'debt_summary' });
    case 'goal_progress':
      return Object.freeze({ type: 'goal_progress' });
    case 'bank_split': {
      const merchant = textOrNull(value.merchant, 60);
      const groupName = textOrNull(value.groupName, 80);
      if (!merchant || !groupName) throw invalid('Choose a merchant and group to split.');
      return Object.freeze({ type: 'bank_split', merchant, groupName });
    }
    case 'expense_help':
      return Object.freeze({ type: 'expense_help', groupName: textOrNull(value.groupName, 80) });
    default:
      throw invalid('Unknown Ask action.');
  }
}

function transactionQuery(action) {
  return {
    merchant: action.merchant, category: action.category, direction: 'debit', status: null,
    from: action.from, to: action.to, limit: 10,
  };
}

function spendingQuery(action) {
  return {
    merchant: null, category: action.category, direction: null, status: null,
    from: action.from, to: action.to, limit: 10,
  };
}

/**
 * Execute a validated chip action without Gemini.
 * Returns null only if a required dependency is missing (caller falls through).
 */
export async function executeAskAction({
  action, actor, message, requestKey, withTransaction, conversationalReads,
  explainCharge, answerFinancial, runExpense,
}) {
  if (action.type === 'transactions') {
    if (!conversationalReads) return null;
    return conversationalReads.transactions({ actor, query: transactionQuery(action) });
  }
  if (action.type === 'spending_guidance') {
    if (!conversationalReads) return null;
    return conversationalReads.spendingGuidance({ actor, query: spendingQuery(action) });
  }
  if (action.type === 'explain_charge') {
    if (!explainCharge) return null;
    const explained = await explainCharge({ actor, merchant: action.merchant });
    return {
      ...explained,
      asOf: new Date().toISOString(),
      conversation: {
        intent: 'explain_charge', merchant: action.merchant, category: explained.category ?? null,
        from: null, to: null,
        focus: Object.freeze({
          categories: Object.freeze(explained.category ? [explained.category] : []),
          merchants: Object.freeze([action.merchant]),
        }),
      },
    };
  }
  if (action.type === 'debt_summary') {
    if (!answerFinancial) return null;
    return answerFinancial({ actor, intent: 'debt_summary' });
  }
  if (action.type === 'goal_progress') {
    return withTransaction((db) => answerGoalProgress(db, actor.userId));
  }
  if (action.type === 'bank_split') {
    if (!runExpense) return null;
    return runExpense({
      message,
      requestKey,
      expense: {
        merchant: action.merchant, cents: null, participantNames: [], groupHint: action.groupName,
      },
      bankMessage: `Split my last ${action.merchant} card purchase with ${action.groupName}`,
    });
  }
  if (action.type === 'expense_help') {
    const group = action.groupName;
    return {
      type: 'answer',
      intent: 'expense',
      answer: group
        ? `Tell me the merchant, amount, and who to split with for ${group}. For example: Spent $42 at Antonio’s, split with Sam.`
        : 'Tell me the merchant, amount, and who to split with. For example: Spent $42 at Antonio’s, split with Sam and Priya.',
      conversation: {
        intent: 'expense', merchant: null, category: null, from: null, to: null,
        focus: emptyFocus(),
      },
    };
  }
  return null;
}
