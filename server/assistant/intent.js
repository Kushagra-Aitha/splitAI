import { HttpError } from '../http.js';

export const MAX_MESSAGE_LENGTH = 500;
const INTENTS = ['expense', 'affordability', 'debt_summary', 'spending_insight', 'unsupported'];
const EXPENSE_KEYS = ['merchant', 'cents', 'participantNames', 'groupHint'];
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
  },
};

function invalidOutput() {
  return new HttpError(502, 'INVALID_ASSISTANT_OUTPUT', 'Split could not interpret that safely. Try again or enter the expense manually.');
}

function hasExactKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
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

export function validateIntent(value) {
  if (!hasExactKeys(value, ['intent', 'expense']) || !INTENTS.includes(value.intent)) throw invalidOutput();
  if (value.intent !== 'expense') {
    if (value.expense !== null) throw invalidOutput();
    return Object.freeze({ intent: value.intent, expense: null });
  }
  const expense = value.expense;
  if (!hasExactKeys(expense, EXPENSE_KEYS)) throw invalidOutput();
  if (expense.cents !== null && (!Number.isSafeInteger(expense.cents) || expense.cents <= 0)) throw invalidOutput();
  if (!Array.isArray(expense.participantNames) || expense.participantNames.length > 20) throw invalidOutput();
  const participantNames = expense.participantNames.map((name) => {
    if (name === null) throw invalidOutput();
    return textOrNull(name, 80);
  });
  // Preserve repeated names: two people named Sam require explicit resolution
  // in C2. Dedupe here would silently alter the proposed split.
  return Object.freeze({
    intent: 'expense',
    expense: Object.freeze({
      merchant: textOrNull(expense.merchant, 60),
      cents: expense.cents,
      participantNames: Object.freeze(participantNames),
      groupHint: textOrNull(expense.groupHint, 80),
    }),
  });
}
