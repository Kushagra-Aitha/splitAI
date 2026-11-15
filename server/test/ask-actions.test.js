import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { validateAskAction } from '../assistant/actions.js';
import { createAskWorkflow } from '../assistant/workflow.js';

const actor = { userId: '10000000-0000-4000-8000-000000000001' };
const requestKey = '90000000-0000-4000-8000-000000000020';

function askWith(overrides = {}) {
  return createAskWorkflow({
    query: async () => ({ rows: [] }),
    withTransaction: async (fn) => fn({ query: async () => ({ rows: [] }) }),
    classifyInput: async () => ({ flagged: false }),
    parseIntent: async () => assert.fail('chip actions must not call Gemini'),
    ...overrides,
  });
}

test('Ask action schema accepts label digests and rejects amounts or unknown keys', () => {
  assert.deepEqual(
    validateAskAction({ type: 'transactions', merchant: 'Amazon', category: null, from: null, to: null }),
    { type: 'transactions', merchant: 'Amazon', category: null, from: null, to: null },
  );
  assert.throws(() => validateAskAction({ type: 'explain_charge', merchant: 'Amazon', amountCents: 4200 }),
    (error) => error.status === 422 && error.code === 'INVALID_ASK_ACTION');
  assert.throws(() => validateAskAction({ type: 'bank_split', merchant: 'Amazon', groupName: 'Crabs', cents: 1 }),
    (error) => error.status === 422 && error.code === 'INVALID_ASK_ACTION');
  assert.throws(() => validateAskAction({ type: 'teleport', merchant: 'Amazon' }),
    (error) => error.status === 422 && error.code === 'INVALID_ASK_ACTION');
});

test('transactions and spending_guidance chip actions route without Gemini', async () => {
  let seen;
  const ask = askWith({
    conversationalReads: {
      transactions: async ({ query }) => {
        seen = { kind: 'transactions', query };
        return { type: 'answer', intent: 'transactions', answer: 'listed', transactions: [] };
      },
      spendingGuidance: async ({ query }) => {
        seen = { kind: 'spending_guidance', query };
        return { type: 'answer', intent: 'spending_guidance', answer: 'guided' };
      },
    },
  });
  const listed = await ask({
    actor,
    body: {
      message: 'Show my recent Housing transactions',
      requestKey,
      action: { type: 'transactions', merchant: null, category: 'Housing', from: '2026-11-01', to: '2026-11-15' },
    },
  });
  assert.equal(listed.intent, 'transactions');
  assert.deepEqual(seen, {
    kind: 'transactions',
    query: { merchant: null, category: 'Housing', direction: 'debit', status: null,
      from: '2026-11-01', to: '2026-11-15', limit: 10 },
  });

  const guided = await ask({
    actor,
    body: {
      message: 'How is my Shopping spending?',
      requestKey: '90000000-0000-4000-8000-000000000021',
      action: { type: 'spending_guidance', category: 'Shopping', from: null, to: null },
    },
  });
  assert.equal(guided.intent, 'spending_guidance');
  assert.equal(seen.kind, 'spending_guidance');
  assert.equal(seen.query.category, 'Shopping');
});

test('explain_charge and financial chip actions route without Gemini', async () => {
  const ask = askWith({
    explainCharge: async ({ merchant }) => ({
      type: 'answer', intent: 'explain_charge', answer: `Explained ${merchant}`, category: 'Shopping',
    }),
    answerFinancial: async ({ intent }) => ({ type: 'answer', intent, answer: `Financial ${intent}` }),
    withTransaction: async (fn) => fn({ query: async () => ({ rows: [] }) }),
  });
  const explained = await ask({
    actor,
    body: {
      message: 'Explain my Kushagra Land charge',
      requestKey: '90000000-0000-4000-8000-000000000022',
      action: { type: 'explain_charge', merchant: 'Kushagra Land' },
    },
  });
  assert.equal(explained.intent, 'explain_charge');
  assert.match(explained.answer, /Kushagra Land/u);
  assert.equal(explained.conversation.merchant, 'Kushagra Land');

  const debts = await ask({
    actor,
    body: {
      message: 'What do I owe?',
      requestKey: '90000000-0000-4000-8000-000000000023',
      action: { type: 'debt_summary' },
    },
  });
  assert.equal(debts.intent, 'debt_summary');

  const goals = await ask({
    actor,
    body: {
      message: 'How are my goals doing?',
      requestKey: '90000000-0000-4000-8000-000000000024',
      action: { type: 'goal_progress' },
    },
  });
  assert.equal(goals.intent, 'goal_progress');
  assert.match(goals.answer, /no savings goals/iu);
});

test('bank_split chip action opens an expense proposal without Gemini', async () => {
  let advanced = null;
  const message = 'Split my last Kushagra Land card purchase with Crabs';
  const ask = askWith({
    query: async () => ({ rows: [] }),
    withTransaction: async (fn) => fn({
      query: async (sql, params) => {
        if (sql.startsWith('INSERT INTO assistant_proposals')) {
          advanced = {
            id: '80000000-0000-4000-8000-000000000001',
            messageHash: createHash('sha256').update(JSON.stringify(message)).digest('hex'),
            extraction: JSON.parse(params[3]),
            draftId: null,
            selectionHash: null,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            bankQuery: params[4] ? JSON.parse(params[4]) : null,
          };
          return { rows: [] };
        }
        if (sql.includes('FROM assistant_proposals')) return { rows: [advanced] };
        if (sql.includes('FROM groups') || sql.includes('group_members')) {
          return { rows: [{ id: '70000000-0000-4000-8000-000000000001', name: 'Crabs',
            userId: actor.userId, displayName: 'Maya', fullName: 'Maya Chen' }] };
        }
        if (sql.includes('FROM bank_accounts')) {
          return { rows: [{
            accountId: '20000000-0000-4000-8000-000000000001', accountKind: 'credit_card', mask: '4242',
            providerKey: 'nessie-1', merchant: 'Kushagra Land', cents: '6769',
            occurredAt: '2026-11-14T12:00:00Z',
          }] };
        }
        return { rows: [] };
      },
    }),
  });
  const result = await ask({
    actor,
    body: {
      message,
      requestKey: '90000000-0000-4000-8000-000000000025',
      action: { type: 'bank_split', merchant: 'Kushagra Land', groupName: 'Crabs' },
    },
  });
  assert.equal(result.intent, 'expense');
  assert.ok(['draft', 'selection_needed'].includes(result.type), result.type);
  assert.equal(result.extraction?.merchant, 'Kushagra Land');
  assert.equal(result.extraction?.groupHint, 'Crabs');
  assert.equal(advanced.bankQuery?.merchant, 'kushagraland');
});

test('expense_help chip action returns a recording hint without Gemini', async () => {
  const ask = askWith();
  const result = await ask({
    actor,
    body: {
      message: 'Help me record an expense for Crabs',
      requestKey: '90000000-0000-4000-8000-000000000026',
      action: { type: 'expense_help', groupName: 'Crabs' },
    },
  });
  assert.equal(result.type, 'answer');
  assert.match(result.answer, /Crabs/u);
});
