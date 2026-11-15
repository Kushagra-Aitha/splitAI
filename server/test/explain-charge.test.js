import assert from 'node:assert/strict';
import test from 'node:test';
import { chargeExplanationTarget, createChargeExplanation } from '../ledger/explain-charge.js';

test('Ask explain phrases resolve the merchant name', () => {
  assert.equal(chargeExplanationTarget('Explain my Amazon charge'), 'Amazon');
  assert.equal(chargeExplanationTarget('please explain the Domino’s charge'), 'Domino’s');
  assert.equal(chargeExplanationTarget('What do I owe?'), null);
});

test('byMerchant falls back to the latest linked bank purchase when no group expense exists', async () => {
  const explain = createChargeExplanation({
    withTransaction: async (fn) => fn({
      query: async (sql) => {
        if (sql.includes('FROM expenses')) return { rows: [] };
        if (sql.includes('FROM bank_accounts')) {
          return { rows: [{
            id: '20000000-0000-4000-8000-000000000001',
            merchant: 'Amazon',
            amountCents: 4599,
            status: 'completed',
            occurredAt: '2026-11-14T17:00:00Z',
            category: 'Shopping',
            accountKind: 'credit_card',
            accountMask: '4242',
            splitGroupName: null,
          }, {
            id: '20000000-0000-4000-8000-000000000002',
            merchant: 'Amazon',
            amountCents: 1200,
            status: 'completed',
            occurredAt: '2026-11-01T17:00:00Z',
            category: 'Shopping',
            accountKind: 'credit_card',
            accountMask: '4242',
            splitGroupName: null,
          }] };
        }
        return { rows: [] };
      },
    }),
    explain: async (statements) => Object.values(statements).join(' '),
  });
  const result = await explain.byMerchant({
    actor: { userId: '10000000-0000-4000-8000-000000000001' },
    merchant: 'Amazon',
  });
  assert.equal(result.intent, 'explain_charge');
  assert.match(result.answer, /Amazon/u);
  assert.match(result.answer, /\$45\.99/u);
  assert.match(result.answer, /credit card ending in 4242/u);
  assert.match(result.answer, /not linked to a confirmed shared expense/iu);
  assert.match(result.answer, /2 matching Amazon bank purchases/u);
});
