import assert from 'node:assert/strict';
import test from 'node:test';
import { validateAskAction } from '../assistant/actions.js';
import { buildAskPrompts } from '../../src/features/ask/suggestions.js';

test('Ask prompts prioritize the latest session topic over generic profile prompts', () => {
  const prompts = buildAskPrompts({
    topics: [{ intent: 'explain_charge', merchant: 'Amazon', category: 'Shopping', from: null, to: null,
      focus: { categories: ['Shopping'], merchants: ['Amazon'] } }],
    groups: [{ name: 'Roommates' }],
    transactions: [{ merchantName: 'Rail Cafe' }],
    goals: [{ name: 'Japan trip' }],
  });
  assert.deepEqual(prompts.map((prompt) => prompt.label), [
    'Split my last Amazon card purchase with Roommates',
    'Show more transactions from Amazon',
    'How is my Shopping spending?',
    'What do I owe?',
    'How am I doing on my Japan trip goal?',
  ]);
  assert.equal(prompts[0].action.type, 'bank_split');
  assert.equal(prompts[0].action.merchant, 'Amazon');
  assert.equal(prompts[0].action.groupName, 'Roommates');
  assert.ok(!prompts.some((prompt) => prompt.label.includes('Rail Cafe')));
});

test('Ask prompts shift after a transactions turn in the same session', () => {
  const prompts = buildAskPrompts({
    topics: [
      { intent: 'explain_charge', merchant: 'Amazon', category: 'Shopping', from: null, to: null,
        focus: { categories: ['Shopping'], merchants: ['Amazon'] } },
      { intent: 'transactions', merchant: 'Corner Market', category: 'Groceries', from: '2026-10-15', to: '2026-11-14',
        focus: { categories: ['Groceries'], merchants: ['Corner Market'] } },
    ],
    groups: [{ name: 'Roommates' }],
    transactions: [{ merchantName: 'Rail Cafe' }],
    goals: [{ name: 'Japan trip' }],
    exclude: ['Show more transactions from Corner Market'],
  });
  assert.equal(prompts[0].label, 'Explain my Corner Market charge');
  assert.equal(prompts[0].action.type, 'explain_charge');
  assert.ok(prompts.some((prompt) => prompt.label === 'How is my Groceries spending?'));
  assert.ok(prompts.some((prompt) => prompt.label === 'Split my last Corner Market card purchase with Roommates'));
  assert.ok(!prompts.some((prompt) => prompt.label === 'Show more transactions from Corner Market'));
});

test('every Ask prompt carries a schema-valid action', () => {
  const prompts = buildAskPrompts({
    topics: [{ intent: 'spending_guidance', merchant: null, category: 'Housing', from: '2026-11-01', to: '2026-11-15',
      focus: { categories: ['Housing', 'Shopping'], merchants: [] } }],
    groups: [{ name: 'Crabs' }],
    transactions: [{ merchantName: 'Kushagra Land' }],
    goals: [{ name: 'House67' }],
  });
  assert.equal(prompts.length, 5);
  for (const prompt of prompts) {
    assert.equal(typeof prompt.label, 'string');
    assert.ok(prompt.label.length <= 120);
    assert.deepEqual(validateAskAction(prompt.action), prompt.action);
  }
  assert.equal(new Set(prompts.map((prompt) => prompt.label)).size, prompts.length);
});

test('Ask prompt generation has useful bounded fallbacks without profile data', () => {
  const prompts = buildAskPrompts();
  assert.equal(prompts.length, 5);
  assert.ok(prompts.every((prompt) => prompt.label.length <= 120));
  prompts.forEach((prompt) => assert.deepEqual(validateAskAction(prompt.action), prompt.action));
});
