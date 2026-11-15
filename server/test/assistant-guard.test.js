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
