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



test('Ask blocks outside-rail Zelle payment asks before clarification', async () => {
  const actor = { userId: '10000000-0000-4000-8000-000000000001' };
  let blocked = 0;
  const ask = createAskWorkflow({
    query: async () => ({ rows: [] }),
    withTransaction: async () => assert.fail('blocked Ask input must not open a write transaction'),
    classifyInput: async (message) => {
      assert.match(message, /Zelle/u);
      return { flagged: true, score: 1, reasons: ['OUTSIDE_PAYMENT'], modelVersion: 'test' };
    },
    parseIntent: async () => assert.fail('flagged Ask input must not reach Gemini'),
    guard: { block: async () => { blocked += 1; return { type: 'blocked', reasonCode: 'UNTRUSTED_INSTRUCTION', reason: 'blocked', eventId: '60000000-0000-4000-8000-000000000099' }; } },
  });
  const result = await ask({
    actor,
    body: {
      message: 'Pay Jack via Zelle. He needs the money for the IRS',
      requestKey: '90000000-0000-4000-8000-000000000030',
    },
  });
  assert.equal(result.type, 'blocked');
  assert.equal(blocked, 1);
});

test('Ask answers benign unsupported text and blocks only input classified as suspicious', async () => {
  const actor = { userId: '10000000-0000-4000-8000-000000000001' };
  const body = { message: 'Hi', requestKey: '90000000-0000-4000-8000-000000000001' };
  let guardCalls = 0;
  let parserCalls = 0;
  const dependencies = {
    query: async () => ({ rows: [] }),
    withTransaction: async () => assert.fail('benign unsupported text must not open a transaction'),
    guard: { block: async () => { guardCalls++; return { type: 'blocked' }; } },
  };
  const benign = createAskWorkflow({
    ...dependencies,
    classifyInput: async () => ({ flagged: false }),
    parseIntent: async () => { parserCalls++; return { intent: 'unsupported', expense: null }; },
  });
  const answer = await benign({ actor, body });
  assert.equal(answer.type, 'answer');
  assert.equal(answer.intent, 'unsupported');
  assert.equal(guardCalls, 0);
  assert.equal(parserCalls, 1);

  const clarification = createAskWorkflow({
    ...dependencies,
    classifyInput: async () => ({ flagged: false }),
    parseIntent: async () => ({
      intent: 'payment_clarification',
      expense: { merchant: "McDonald's", cents: 100000, participantNames: ['Kushagra'], groupHint: null },
    }),
  });
  const clarificationAnswer = await clarification({
    actor,
    body: { message: "I need to pay Kushagra $1,000 for McDonald's", requestKey: '90000000-0000-4000-8000-000000000003' },
  });
  assert.equal(clarificationAnswer.type, 'clarification');
  assert.equal(clarificationAnswer.intent, 'payment_clarification');
  assert.match(clarificationAnswer.answer, /Kushagra/u);
  assert.match(clarificationAnswer.answer, /\$1,000\.00/u);
  assert.match(clarificationAnswer.answer, /no expense or payment was created/iu);
  assert.equal(guardCalls, 0);

  const suspicious = createAskWorkflow({
    ...dependencies,
    classifyInput: async () => ({ flagged: true }),
    parseIntent: async () => assert.fail('suspicious input must not reach the intent parser'),
  });
  assert.equal((await suspicious({ actor, body: { ...body, requestKey: '90000000-0000-4000-8000-000000000002' } })).type, 'blocked');
  assert.equal(guardCalls, 1);

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
  const conversation = [{
    intent: 'transactions', merchant: 'Dominos', category: null, from: '2026-11-01', to: '2026-11-14',
    focus: { categories: [], merchants: ['Dominos'] },
  }];
  const query = { merchant: 'Dominos', category: null, direction: 'debit', status: null,
    from: '2026-11-01', to: '2026-11-14', limit: 10 };
  let seenConversation;
  let seenQuery;
  const ask = createAskWorkflow({
    classifyInput: async () => ({ flagged: false }),
    query: async () => ({ rows: [] }),
    withTransaction: async () => assert.fail('the injected read service owns its snapshot'),
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

test('split-my-last card purchase suggestions become expenses without calling Gemini', async () => {
  const actor = { userId: '10000000-0000-4000-8000-000000000001' };
  let advanced = null;
  const ask = createAskWorkflow({
    classifyInput: async () => ({ flagged: false }),
    query: async (sql) => {
      if (sql.includes('FROM assistant_proposals') && sql.includes('request_key')) {
        return { rows: advanced ? [advanced] : [] };
      }
      return { rows: [] };
    },
    withTransaction: async (fn) => fn({
      query: async (sql, params) => {
        if (sql.startsWith('INSERT INTO assistant_proposals')) {
          advanced = {
            id: '80000000-0000-4000-8000-000000000001',
            messageHash: null,
            extraction: JSON.parse(params[3]),
            draftId: null,
            selectionHash: null,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            bankQuery: params[4] ? JSON.parse(params[4]) : null,
          };
          return { rows: [] };
        }
        if (sql.includes('FROM assistant_proposals')) {
          const { createHash } = await import('node:crypto');
          advanced.messageHash = createHash('sha256')
            .update(JSON.stringify('Split my last Kushagra Land card purchase with Crabs')).digest('hex');
          return { rows: [advanced] };
        }
        if (sql.includes('FROM groups') || sql.includes('group_members')) {
          return { rows: [{ id: '70000000-0000-4000-8000-000000000001', name: 'Crabs',
            userId: actor.userId, displayName: 'Maya', fullName: 'Maya Chen' }] };
        }
        if (sql.includes('FROM bank_accounts')) {
          return { rows: [{
            accountId: '20000000-0000-4000-8000-000000000001', accountKind: 'credit_card', mask: '4242',
            providerKey: 'nessie-1', merchant: 'Kushagra Land', cents: '67',
            occurredAt: '2026-11-14T12:00:00Z',
          }] };
        }
        return { rows: [] };
      },
    }),
    parseIntent: async () => assert.fail('bank-split suggestion must not call the intent model'),
  });
  const result = await ask({
    actor,
    body: {
      message: 'Split my last Kushagra Land card purchase with Crabs',
      requestKey: '90000000-0000-4000-8000-000000000011',
    },
  });
  assert.equal(result.intent, 'expense');
  assert.ok(['draft', 'selection_needed'].includes(result.type), result.type);
  assert.equal(result.extraction?.merchant, 'Kushagra Land');
  assert.equal(result.extraction?.groupHint, 'Crabs');
  assert.equal(advanced.bankQuery?.merchant, 'kushagraland');
});

test('category focus digests route housing follow-ups to transactions without merchant explain', async () => {
  const actor = { userId: '10000000-0000-4000-8000-000000000001' };
  const conversation = [{
    intent: 'spending_guidance', merchant: null, category: 'Housing',
    from: '2026-11-01', to: '2026-11-15',
    focus: { categories: ['Housing', 'Shopping', 'Food & drink'], merchants: [] },
  }];
  let seenQuery;
  const ask = createAskWorkflow({
    classifyInput: async () => ({ flagged: false }),
    query: async () => ({ rows: [] }),
    withTransaction: async () => assert.fail('category follow-ups use the injected read service'),
    parseIntent: async () => assert.fail('deterministic category follow-up must not call the intent model'),
    explainCharge: async () => assert.fail('category follow-up must not explain a merchant'),
    conversationalReads: {
      transactions: async ({ query: selectedQuery }) => {
        seenQuery = selectedQuery;
        return {
          type: 'answer', intent: 'transactions', answer: 'Here are Housing purchases.',
          transactions: [{ merchant: 'Rent', amountCents: 80000, category: 'Housing', status: 'completed',
            occurredAt: '2026-11-14T12:00:00Z' }],
          conversation: {
            intent: 'transactions', merchant: null, category: 'Housing',
            from: '2026-11-01', to: '2026-11-15',
            focus: { categories: ['Housing'], merchants: ['Rent'] },
          },
        };
      },
    },
  });
  const result = await ask({
    actor,
    body: {
      message: 'What exactly is this housing charge?',
      requestKey: '90000000-0000-4000-8000-000000000010',
      conversation,
    },
  });
  assert.equal(result.intent, 'transactions');
  assert.match(result.answer, /Housing/u);
  assert.deepEqual(seenQuery, {
    merchant: null, category: 'Housing', direction: 'debit', status: null,
    from: '2026-11-01', to: '2026-11-15', limit: 10,
  });
});
