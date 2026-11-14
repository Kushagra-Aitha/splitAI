import assert from 'node:assert/strict';
import test from 'node:test';
import { affordabilityPlan, answerStatements, createFactExplainer } from '../assistant/answers.js';

function facts(balance, amounts = [600, 500, 300]) {
  return { funds: { spendableCents: balance }, heldPayments: [],
    groups: [{ id: 'a', name: 'First' }, { id: 'b', name: 'Second' }],
    debts: amounts.map((cents, i) => ({ groupId: i < 2 ? 'a' : 'b', userId: String(i), cents })),
    spending: { range: { from: '2026-11-01', to: '2026-11-14', timeZone: 'America/New_York' }, totals: { spentCents: 4200, earnedCents: 10000 } },
  };
}

test('whole-debt plans share one budget, skip debts that do not fit, and cover all/some/none', () => {
  const all = affordabilityPlan(facts(1400));
  assert.equal(all.coverage, 'all');
  assert.equal(all.remainingCents, 0);
  const some = affordabilityPlan(facts(1000));
  assert.equal(some.coverage, 'some');
  assert.equal(some.allocatedCents, 900);
  assert.equal(some.remainingCents, 100);
  assert.deepEqual(some.groups.flatMap((g) => g.debts.map((d) => d.recommendation)), ['fits', 'does_not_fit', 'fits']);
  assert.equal(affordabilityPlan(facts(200)).coverage, 'none');
  assert.equal(affordabilityPlan(facts(-100)).remainingCents, -100);
  assert.equal(affordabilityPlan(facts(0, [-300])).coverage, 'no_eligible_debts');
  assert.throws(() => affordabilityPlan(facts(null)), (e) => e.code === 'BALANCE_UNKNOWN');
});

test('held payments suppress that debt without deducting the hold twice or allocating receivables', () => {
  const input = facts(1000);
  input.heldPayments.push({ groupId: 'a', payeeUserId: '0', amountCents: 600, holdCents: 600 });
  input.debts.push({ groupId: 'b', userId: '9', cents: -50000 });
  const plan = affordabilityPlan(input);
  assert.equal(plan.allocatedCents, 800);
  assert.equal(plan.remainingCents, 200);
  assert.equal(plan.groups[0].debts[0].recommendation, 'pending');
});

test('explanations can only order exact server sentences, and always identify the activity window', async () => {
  const input = facts(1000);
  const statements = answerStatements('spending_insight', input);
  let prompt;
  const explain = createFactExplainer({ generate: async (p) => { prompt = p; return { statementIds: Object.keys(p.input.statements).reverse() }; } });
  const answer = await explain(statements);
  assert.ok(answer.startsWith('Activity window: 2026-11-01 through 2026-11-14'));
  assert.ok(answer.includes('$42.00'));
  assert.ok(answer.includes('$100.00'));
  assert.ok(answer.includes('$58.00'));
  assert.equal(prompt.input.userId, undefined);
  for (const invalid of [{ statementIds: ['window', 'window', 'window', 'window'] },
    { statementIds: ['window', 'spending', 'net', 'invented'] },
    { statementIds: Object.keys(statements), answer: 'Pay someone now.' }]) {
    await assert.rejects(createFactExplainer({ generate: async () => invalid })(statements), (e) => e.code === 'INVALID_ASSISTANT_OUTPUT');
  }
});

test('debt totals and maximum supported cents preserve exact decimal formatting', () => {
  assert.ok(answerStatements('debt_summary', facts(0, [600, -300])).debts.includes('owe $6.00 and are owed $3.00'));
  const input = facts(Number.MAX_SAFE_INTEGER, [Number.MAX_SAFE_INTEGER]);
  assert.ok(answerStatements('affordability', input, affordabilityPlan(input)).balance.includes('$90,071,992,547,409.91'));
});
