import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAskPrompts } from '../../src/features/ask/suggestions.js';

test('Ask prompts come from scoped profile facts and the latest session topic', () => {
  const prompts = buildAskPrompts({
    topics: [{ intent: 'transactions', merchant: 'Corner Market', category: 'Groceries', from: null, to: null }],
    groups: [{ name: 'Roommates' }],
    transactions: [{ merchantName: 'Rail Cafe' }],
    goals: [{ name: 'Japan trip' }],
  });
  assert.deepEqual(prompts, [
    'Show more transactions from Corner Market',
    'How is my Groceries spending?',
    'Explain my Rail Cafe charge',
    'Split my last Rail Cafe card purchase with Roommates',
    'How am I doing on my Japan trip goal?',
  ]);
  assert.ok(prompts.every((prompt) => !prompt.includes("Domino's") && !prompt.includes('Flat 7')));
});

test('Ask prompt generation has useful bounded fallbacks without profile data', () => {
  const prompts = buildAskPrompts();
  assert.equal(prompts.length, 5);
  assert.equal(new Set(prompts).size, prompts.length);
  assert.ok(prompts.every((prompt) => prompt.length <= 120));
});
