import { HttpError } from '../http.js';
import { TIME_ZONE } from '../banking/overview.js';
import { MAX_FOCUS_LABELS } from './intent.js';
import { readFinancialFacts } from './facts.js';

const money = (cents) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
const localDate = (date) => new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE }).format(date);
const shift = (date, days) => new Date(Date.parse(`${date}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const exactObject = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const SAFE_WORDS = new Set(`a about accounts after all and are as at be because before between by can
category categories completed credit debit did does for from has have in includes is it its largest
listed matching most no not of on pending purchase purchases recent review shows spending summary
than that the their there these they this through to total transaction transactions was were what
which window with your factual first judgment`.split(/\s+/u));

export async function readAskTransactions({ withTransaction, actorId, filter, now = new Date() }) {
  const today = localDate(now);
  const from = filter.from ?? shift(today, -30);
  const to = filter.to ?? today;
  return withTransaction(async (db) => {
    await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const linked = await db.query('SELECT 1 FROM bank_accounts WHERE user_id = $1 AND linked_at IS NOT NULL LIMIT 1', [actorId]);
    if (!linked.rowCount) throw new HttpError(409, 'NO_LINKED_ACCOUNT', 'Your demo bank account isn’t connected yet.');
    const { rows } = await db.query(`
      SELECT t.id, t.direction, t.kind, t.amount_cents::text AS "amountCents",
        coalesce(nullif(btrim(t.merchant_name), ''), nullif(btrim(t.description), ''), 'Transaction') AS merchant,
        coalesce(nullif(btrim(t.category_override), ''), nullif(btrim(t.category), ''), 'Other') AS category,
        t.status, t.occurred_at AS "occurredAt",
        a.kind AS "accountKind", a.account_mask AS "accountMask", g.name AS "splitGroupName"
      FROM bank_accounts a
      JOIN bank_transactions t ON t.account_id = a.id
      LEFT JOIN bank_import_keys k ON k.account_id = a.id AND k.transaction_id = t.id AND k.occurred_at = t.occurred_at
      LEFT JOIN expenses e ON e.bank_account_id = a.id AND e.bank_provider_key = k.provider_key AND e.status = 'confirmed'
      LEFT JOIN groups g ON g.id = e.group_id
      WHERE a.user_id = $1 AND a.linked_at IS NOT NULL
        AND ($2::text IS NULL OR coalesce(t.merchant_name, t.description, '') ILIKE '%' || $2 || '%')
        AND ($3::text IS NULL OR coalesce(t.category_override, t.category, 'Other') ILIKE '%' || $3 || '%')
        AND ($4::text IS NULL OR t.direction = $4)
        AND ($5::text IS NULL OR t.status = $5)
        AND t.occurred_at >= ($6::date::timestamp AT TIME ZONE '${TIME_ZONE}')
        AND t.occurred_at < (($7::date + 1)::timestamp AT TIME ZONE '${TIME_ZONE}')
      ORDER BY t.occurred_at DESC, t.id
      LIMIT $8`,
    [actorId, filter.merchant, filter.category, filter.direction, filter.status, from, to, filter.limit]);
    const transactions = rows.map((row) => ({ ...row, amountCents: Number(row.amountCents) }));
    if (transactions.some((row) => !Number.isSafeInteger(row.amountCents) || row.amountCents < 0)) {
      throw new HttpError(409, 'FINANCIAL_STATE_INVALID', 'These transactions need a refresh before Split can explain them.');
    }
    return { transactions, range: { from, to, timeZone: TIME_ZONE }, asOf: now.toISOString() };
  });
}

function guidanceFacts(facts, category = null) {
  const requested = category?.toLocaleLowerCase('en-US');
  const rows = facts.spending.breakdown.categories
    .filter((row) => !requested || row.category.toLocaleLowerCase('en-US').includes(requested) ||
      requested.includes(row.category.toLocaleLowerCase('en-US')))
    .sort((left, right) => right.cents - left.cents).slice(0, 5);
  return Object.fromEntries([
    ['window', `This spending summary covers ${facts.spending.range.from} through ${facts.spending.range.to}.`],
    ...rows.map((row, index) => [`category_${index + 1}`, `${row.category} accounts for ${money(row.cents)} of purchases in this window.`]),
    ['guidance', rows.length
      ? `Review ${rows[0].category} first because it is the largest listed purchase category; this is a factual summary, not a spending judgment.`
      : 'No matching purchase category was found in this window.'],
  ]);
}

function validateGroundedOutput(output, facts) {
  const ids = Object.keys(facts);
  if (!exactObject(output, ['answer', 'factIds']) || typeof output.answer !== 'string' ||
      !output.answer.trim() || output.answer.length > 800 || /[\p{Cc}\u202a-\u202e\u2066-\u2069]/u.test(output.answer) ||
      !Array.isArray(output.factIds) || output.factIds.length !== ids.length ||
      new Set(output.factIds).size !== ids.length || output.factIds.some((id) => !ids.includes(id))) return null;
  const source = output.factIds.map((id) => facts[id]).join(' ');
  const protectedTokens = output.answer.match(/\$-?[\d,]+\.\d{2}|\b\d{4}-\d{2}-\d{2}\b|\b\d+(?:\.\d+)?%\b/gu) ?? [];
  const sourceWords = new Set((source.toLocaleLowerCase('en-US').match(/[\p{L}’'-]+/gu) ?? []));
  const answerWords = output.answer.toLocaleLowerCase('en-US').match(/[\p{L}’'-]+/gu) ?? [];
  if (protectedTokens.some((token) => !source.includes(token)) ||
      answerWords.some((word) => !sourceWords.has(word) && !SAFE_WORDS.has(word)) ||
      /\b(?:send|transfer|approve|confirm|click|enter your password|share your code)\b/iu.test(output.answer)) return null;
  return output.answer.trim();
}

export function createGroundedResponder({ generate }) {
  return async (facts) => {
    const fallback = Object.values(facts).join(' ');
    try {
      const output = await generate({
        instructions: `Answer naturally using every supplied fact exactly once. Cite every fact ID.
Do not add amounts, dates, merchants, people, categories, transactions, recommendations, or actions.
Do not tell the user to send, transfer, approve, or confirm money. Return only schema JSON.`,
        input: { facts },
        schema: {
          type: 'object', additionalProperties: false, required: ['answer', 'factIds'],
          properties: {
            answer: { type: 'string', minLength: 1, maxLength: 800 },
            factIds: { type: 'array', minItems: Object.keys(facts).length, maxItems: Object.keys(facts).length,
              items: { type: 'string', enum: Object.keys(facts) } },
          },
        },
      });
      return validateGroundedOutput(output, facts) ?? fallback;
    } catch {
      return fallback;
    }
  };
}

function uniqueLabels(values, maxLength) {
  const seen = new Set();
  const labels = [];
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const label = value.trim();
    if (!label || label.length > maxLength) continue;
    const key = label.toLocaleLowerCase('en-US');
    if (seen.has(key)) continue;
    seen.add(key);
    labels.push(label);
    if (labels.length >= MAX_FOCUS_LABELS) break;
  }
  return labels;
}

function transactionFocus(transactions, category) {
  return Object.freeze({
    categories: Object.freeze(uniqueLabels([
      category,
      ...transactions.map((row) => row.category),
    ], 40)),
    merchants: Object.freeze(uniqueLabels(transactions.map((row) => row.merchant), 60)),
  });
}

function spendingFocus(facts, requestedCategory) {
  const rows = facts.spending.breakdown.categories
    .slice()
    .sort((left, right) => right.cents - left.cents)
    .slice(0, MAX_FOCUS_LABELS);
  const categories = uniqueLabels([
    requestedCategory,
    ...rows.map((row) => row.category),
  ], 40);
  return {
    category: requestedCategory || categories[0] || null,
    focus: Object.freeze({
      categories: Object.freeze(categories),
      merchants: Object.freeze([]),
    }),
  };
}

export function createConversationalReads({ withTransaction, respond, now = () => new Date() }) {
  return {
    transactions: async ({ actor, query }) => {
      const result = await readAskTransactions({ withTransaction, actorId: actor.userId, filter: query, now: now() });
      const count = result.transactions.length;
      const answer = count
        ? `Here ${count === 1 ? 'is 1 transaction' : `are ${count} transactions`} from ${result.range.from} through ${result.range.to}.`
        : `I couldn’t find matching transactions from ${result.range.from} through ${result.range.to}. Try another merchant, category, or date range.`;
      return {
        type: 'answer', intent: 'transactions', answer, transactions: result.transactions,
        asOf: result.asOf, conversation: {
          intent: 'transactions', merchant: query.merchant, category: query.category,
          from: result.range.from, to: result.range.to,
          focus: transactionFocus(result.transactions, query.category),
        },
      };
    },
    spendingGuidance: async ({ actor, query }) => {
      const params = new URLSearchParams();
      if (query.from) params.set('from', query.from);
      if (query.to) params.set('to', query.to);
      const facts = await readFinancialFacts({ withTransaction, actorId: actor.userId, query: params, now: now() });
      const cards = guidanceFacts(facts, query.category);
      const digest = spendingFocus(facts, query.category);
      return {
        type: 'answer', intent: 'spending_guidance', answer: await respond(cards),
        asOf: facts.asOf, balanceAsOf: facts.funds.balanceAsOf, spending: facts.spending,
        conversation: {
          intent: 'spending_guidance', merchant: null, category: digest.category,
          from: facts.spending.range.from, to: facts.spending.range.to, focus: digest.focus,
        },
      };
    },
  };
}
