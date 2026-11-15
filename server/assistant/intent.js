import { HttpError } from '../http.js';

export const MAX_MESSAGE_LENGTH = 500;
export const MAX_CONVERSATION_TURNS = 4;
const INTENTS = ['expense', 'affordability', 'debt_summary', 'spending_insight', 'spending_guidance', 'transactions',
  'explain_charge', 'goal_progress', 'reminder', 'payment_clarification', 'unsupported'];
const EXPENSE_KEYS = ['merchant', 'cents', 'participantNames', 'groupHint'];
const QUERY_KEYS = ['merchant', 'category', 'direction', 'status', 'from', 'to', 'limit'];
const CONTEXT_KEYS = ['intent', 'merchant', 'category', 'from', 'to'];
const CONTROL_CHARACTERS = /[\p{Cc}\u202a-\u202e\u2066-\u2069]/u;

// The provider schema improves output consistency. validateIntent is the
// authoritative boundary: provider output never becomes trusted by declaration.
export const INTENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['intent', 'expense'],
  properties: {
    intent: { type: 'string', enum: INTENTS },
    expense: {
      anyOf: [
        { type: 'null' },
        {
          type: 'object',
          additionalProperties: false,
          required: EXPENSE_KEYS,
          properties: {
            merchant: { type: ['string', 'null'], maxLength: 60 },
            cents: { type: ['integer', 'null'], minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
            participantNames: { type: 'array', maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 80 } },
            groupHint: { type: ['string', 'null'], maxLength: 80 },
          },
        },
      ],
    },
    query: {
      anyOf: [
        { type: 'null' },
        {
          type: 'object',
          additionalProperties: false,
          required: QUERY_KEYS,
          properties: {
            merchant: { type: ['string', 'null'], maxLength: 60 },
            category: { type: ['string', 'null'], maxLength: 40 },
            direction: { type: ['string', 'null'], enum: ['debit', 'credit', null] },
            status: { type: ['string', 'null'], enum: ['pending', 'completed', null] },
            from: { type: ['string', 'null'], maxLength: 10 },
            to: { type: ['string', 'null'], maxLength: 10 },
            limit: { type: 'integer', minimum: 1, maximum: 20 },
          },
        },
      ],
    },
  },
};

function invalidOutput() {
  return new HttpError(502, 'INVALID_ASSISTANT_OUTPUT', 'Split could not interpret that safely. Try again or enter the expense manually.');
}

function hasExactKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function hasOnlyKeys(value, required, allowed) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => allowed.includes(key));
}

function textOrNull(value, maxLength) {
  if (value === null) return null;
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength || CONTROL_CHARACTERS.test(value)) {
    throw invalidOutput();
  }
  return value.trim();
}

export function validateMessage(body) {
  if (typeof body?.message !== 'string' || !body.message.trim() || body.message.length > MAX_MESSAGE_LENGTH) {
    throw new HttpError(422, 'INVALID_MESSAGE', `Enter a message between 1 and ${MAX_MESSAGE_LENGTH} characters.`);
  }
  return body.message.trim();
}

const dateOrNull = (value) => {
  if (value === null) return null;
  const date = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value) ? new Date(`${value}T12:00:00Z`) : null;
  if (!date || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw invalidOutput();
  return value;
};

function validateQuery(value) {
  if (!hasExactKeys(value, QUERY_KEYS)) throw invalidOutput();
  const direction = value.direction;
  const status = value.status;
  if (![null, 'debit', 'credit'].includes(direction) || ![null, 'pending', 'completed'].includes(status) ||
      !Number.isInteger(value.limit) || value.limit < 1 || value.limit > 20) throw invalidOutput();
  const query = Object.freeze({
    merchant: textOrNull(value.merchant, 60),
    category: textOrNull(value.category, 40),
    direction,
    status,
    from: dateOrNull(value.from),
    to: dateOrNull(value.to),
    limit: value.limit,
  });
  if (query.from && query.to && query.from > query.to) throw invalidOutput();
  return query;
}

export function validateConversation(value) {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > MAX_CONVERSATION_TURNS) {
    throw new HttpError(422, 'INVALID_ASK_CONTEXT', `Send at most ${MAX_CONVERSATION_TURNS} prior Ask topics.`);
  }
  return Object.freeze(value.map((item) => {
    if (!hasExactKeys(item, CONTEXT_KEYS) || !INTENTS.includes(item.intent)) {
      throw new HttpError(422, 'INVALID_ASK_CONTEXT', 'Ask conversation context is invalid.');
    }
    try {
      return Object.freeze({
        intent: item.intent,
        merchant: textOrNull(item.merchant, 60),
        category: textOrNull(item.category, 40),
        from: dateOrNull(item.from),
        to: dateOrNull(item.to),
      });
    } catch {
      throw new HttpError(422, 'INVALID_ASK_CONTEXT', 'Ask conversation context is invalid.');
    }
  }));
}

export function validateIntent(value) {
  if (!hasOnlyKeys(value, ['intent', 'expense'], ['intent', 'expense', 'query']) || !INTENTS.includes(value.intent)) throw invalidOutput();
  const query = Object.hasOwn(value, 'query') && value.query !== null ? validateQuery(value.query) : null;
  if (['transactions', 'spending_guidance'].includes(value.intent) && !query) throw invalidOutput();
  if (!['transactions', 'spending_guidance'].includes(value.intent) && query) throw invalidOutput();
  if (!['expense', 'reminder', 'payment_clarification'].includes(value.intent)) {
    if (value.expense !== null) throw invalidOutput();
    return Object.freeze({ intent: value.intent, expense: null, ...(query ? { query } : {}) });
  }
  const expense = value.expense;
  if (!hasExactKeys(expense, EXPENSE_KEYS)) throw invalidOutput();
  if (value.intent === 'reminder' && expense.cents !== null) throw invalidOutput();
  if (expense.cents !== null && (!Number.isSafeInteger(expense.cents) || expense.cents <= 0)) throw invalidOutput();
  if (!Array.isArray(expense.participantNames) || expense.participantNames.length > 20) throw invalidOutput();
  const participantNames = expense.participantNames.map((name) => {
    if (name === null) throw invalidOutput();
    return textOrNull(name, 80);
  });
  // Preserve repeated names: two people named Sam require explicit resolution
  // in C2. Dedupe here would silently alter the proposed split.
  return Object.freeze({
    intent: value.intent,
    expense: Object.freeze({
      merchant: textOrNull(expense.merchant, 60),
      cents: expense.cents,
      participantNames: Object.freeze(participantNames),
      groupHint: textOrNull(expense.groupHint, 80),
    }),
  });
}
