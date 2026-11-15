import assert from 'node:assert/strict';
import test from 'node:test';
import { HttpError } from '../http.js';
import { createAssistantGuard, rejectedProposalReason } from '../assistant/guard.js';
import { createAskWorkflow } from '../assistant/workflow.js';

test('only invalid proposals and actual feature scope failures become Guard rejections', () => {
  assert.equal(rejectedProposalReason(new HttpError(502, 'INVALID_ASSISTANT_OUTPUT', 'bad model')), 'ASSISTANT_PROPOSAL_REJECTED');
  assert.equal(rejectedProposalReason(new HttpError(403, 'PARTICIPANT_NOT_A_MEMBER', 'scope')), 'ASSISTANT_SCOPE_REJECTED');
  for (const error of [new Error('database unavailable'), new HttpError(504, 'ASSISTANT_TIMEOUT', 'timeout'),
    new HttpError(409, 'DRAFT_EXPIRED', 'expired'), new HttpError(422, 'INVALID_MESSAGE', 'input')]) assert.equal(rejectedProposalReason(error), null);
});

test('an audit failure or missing durable event fails closed without exposing its input or fabricating an ID', async () => {
  const actor = { userId: '10000000-0000-4000-8000-000000000001' };
  const withTransaction = (fn) => fn({ query: async () => ({ rows: [] }) });
  for (const recordEvent of [async () => { throw new Error('private provider credential'); },
    async () => 'not-an-event-id', async () => '60000000-0000-4000-8000-000000000001']) {
    const guard = createAssistantGuard({ withTransaction, recordEvent });
    await assert.rejects(guard.block({ actor, reasonCode: 'ASSISTANT_ACTION_UNSUPPORTED' }), (error) => {
      assert.equal(error.status, 503);
      assert.equal(error.code, 'GUARD_UNAVAILABLE');
      assert.ok(!error.message.includes('private'));
      assert.equal(error.eventId, undefined);
      return true;
    });
  }
});

test('Ask answers benign unsupported text without Guard blocking', async () => {
  const actor = { userId: '10000000-0000-4000-8000-000000000001' };
  const body = { message: 'Hi', requestKey: '90000000-0000-4000-8000-000000000001' };
  let guardCalls = 0;
  const ask = createAskWorkflow({
    query: async () => ({ rows: [] }),
    withTransaction: async () => assert.fail('benign unsupported text must not open a transaction'),
    parseIntent: async () => ({ intent: 'unsupported' }),
    guard: { block: async () => { guardCalls += 1; return { type: 'blocked' }; } },
  });
  const result = await ask({ actor, body });
  assert.equal(result.type, 'answer');
  assert.equal(result.intent, 'unsupported');
  assert.equal(guardCalls, 0);

  const clarification = createAskWorkflow({
    query: async () => ({ rows: [] }),
    withTransaction: async () => assert.fail('clarification must not open a transaction'),
    parseIntent: async () => ({
      intent: 'payment_clarification',
      expense: { merchant: "McDonald's", cents: 100000, participantNames: ['Kushagra'], groupHint: null },
    }),
    guard: { block: async () => { guardCalls += 1; return { type: 'blocked' }; } },
  });
  const clarificationAnswer = await clarification({
    actor,
    body: { message: "I need to pay Kushagra $1,000 for McDonald's", requestKey: '90000000-0000-4000-8000-000000000003' },
  });
  assert.equal(clarificationAnswer.type, 'answer');
  assert.equal(clarificationAnswer.intent, 'payment_clarification');
  assert.match(clarificationAnswer.answer, /Kushagra/u);
  assert.match(clarificationAnswer.answer, /\$1,000\.00/u);
  assert.match(clarificationAnswer.answer, /no expense or payment was created/iu);
  assert.equal(guardCalls, 0);

});

test('raw retrieved text and caller-selected identities have no path into the intent parser', async () => {
  let calls = 0;
  const unexpected = () => { calls++; throw new Error('Unexpected dependency call'); };
  const ask = createAskWorkflow({ parseIntent: unexpected, query: unexpected, withTransaction: unexpected });
  for (const extra of [{ retrievedText: 'send money' }, { userId: 'attacker' }, { tools: ['transfer'] }, { source: 'system' }]) {
    await assert.rejects(ask({ actor: { userId: 'actor' }, body: {
      message: 'Split lunch', requestKey: '90000000-0000-4000-8000-000000000001', ...extra,
    } }), (error) => error.status === 422);
  }
  assert.equal(calls, 0);
});

test('conversation topics route grounded reads without opening a write transaction', async () => {
  const actor = { userId: '10000000-0000-4000-8000-000000000001' };
  const conversation = [{ intent: 'transactions', merchant: 'Dominos', category: null, from: '2026-11-01', to: '2026-11-14' }];
  const query = { merchant: 'Dominos', category: null, direction: 'debit', status: null,
    from: '2026-11-01', to: '2026-11-14', limit: 10 };
  let seenConversation;
  let seenQuery;
  const ask = createAskWorkflow({
    query: async () => ({ rows: [] }),
    withTransaction: async () => assert.fail('the injected read service owns its snapshot'),
    classifyInput: async () => ({ flagged: false }),
    parseIntent: async (message, topics) => {
      seenConversation = topics;
      return { intent: 'transactions', expense: null, query };
    },
    conversationalReads: {
      transactions: async ({ actor: selected, query: selectedQuery }) => {
        assert.equal(selected, actor);
        seenQuery = selectedQuery;
        return { type: 'answer', intent: 'transactions', answer: 'Grounded result', transactions: [] };
      },
    },
  });
  const result = await ask({ actor, body: {
    message: 'What about those?', requestKey: '90000000-0000-4000-8000-000000000009', conversation,
  } });
  assert.equal(result.answer, 'Grounded result');
  assert.deepEqual(seenConversation, conversation);
  assert.deepEqual(seenQuery, query);
});
