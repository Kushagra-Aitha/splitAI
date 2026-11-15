import { HttpError } from '../http.js';
import { readFinancialFacts, validateFactAmounts } from './facts.js';

const money = (cents) => {
  const value = BigInt(cents);
  return `${value < 0n ? '-' : ''}$${((value < 0n ? -value : value) / 100n).toLocaleString('en-US')}.${String((value < 0n ? -value : value) % 100n).padStart(2, '0')}`;
};
const safe = (amount) => {
  const n = Number(amount);
  if (!Number.isSafeInteger(n)) throw new HttpError(409, 'FINANCIAL_STATE_INVALID', 'These totals are outside the supported range.');
  return n;
};

export function affordabilityPlan(facts) {
  validateFactAmounts(facts);
  if (facts.funds.spendableCents === null) throw new HttpError(409, 'BALANCE_UNKNOWN', 'Refresh your bank balance before checking which debts fit.');
  let remaining = BigInt(facts.funds.spendableCents);
  let allocated = 0n;
  const held = new Set(facts.heldPayments.map((payment) => `${payment.groupId}:${payment.payeeUserId}`));
  const groups = facts.groups.map((group) => {
    const debts = facts.debts.filter((debt) => debt.groupId === group.id && debt.cents > 0)
      .sort((a, b) => a.userId.localeCompare(b.userId)).map((debt) => {
        const pending = held.has(`${group.id}:${debt.userId}`);
        const fits = !pending && remaining >= BigInt(debt.cents);
        if (fits) { remaining -= BigInt(debt.cents); allocated += BigInt(debt.cents); }
        return { ...debt, recommendation: pending ? 'pending' : fits ? 'fits' : 'does_not_fit', remainingCents: safe(remaining) };
      });
    return { id: group.id, name: group.name, debts };
  });
  const eligible = groups.flatMap((group) => group.debts).filter((debt) => debt.recommendation !== 'pending');
  const fits = eligible.filter((debt) => debt.recommendation === 'fits').length;
  return { policy: 'whole_debts', order: 'group_created_at_then_id__counterparty_id',
    coverage: !eligible.length ? 'no_eligible_debts' : fits === eligible.length ? 'all' : fits ? 'some' : 'none',
    spendableCents: facts.funds.spendableCents, allocatedCents: safe(allocated), remainingCents: safe(remaining), groups };
}

export function answerStatements(intent, facts, plan) {
  const window = `Activity window: ${facts.spending.range.from} through ${facts.spending.range.to} (${facts.spending.range.timeZone}).`;
  if (intent === 'affordability') return {
    balance: `Spendable funds are ${money(plan.spendableCents)}, after goal and settlement holds.`,
    coverage: `${({ all: 'All eligible whole debts fit', some: 'Some eligible whole debts fit', none: 'No eligible whole debts fit', no_eligible_debts: 'There are no eligible unpaid debts to recommend' })[plan.coverage]}.`,
    allocation: `The plan allocates ${money(plan.allocatedCents)} and leaves ${money(plan.remainingCents)} spendable.`,
    policy: 'Debts are checked in group creation order, then group ID and person ID. A debt that does not fit is skipped; later smaller debts may still fit. Debts with a held payment wait for its result. No money has been moved.',
  };
  if (intent === 'debt_summary') {
    const owe = safe(facts.debts.filter((d) => d.cents > 0).reduce((sum, d) => sum + BigInt(d.cents), 0n));
    const owed = safe(facts.debts.filter((d) => d.cents < 0).reduce((sum, d) => sum - BigInt(d.cents), 0n));
    return { debts: `Across your groups, you owe ${money(owe)} and are owed ${money(owed)}.`,
      policy: 'Only posted settlements reduce these debts. Money owed to you does not increase your spendable funds.' };
  }
  const { spentCents, earnedCents } = facts.spending.totals;
  return { window,
    spending: `Purchases total ${money(spentCents)}; deposits total ${money(earnedCents)}.`,
    net: `Deposits minus purchases are ${money(safe(BigInt(earnedCents) - BigInt(spentCents)))} for this window.`,
    policy: 'Pending and completed purchases and deposits are included. Transfers, shared expense obligations, and goal reservations are excluded from these activity totals.' };
}

// Gemini orders application-computed factual sentences. It cannot introduce
// numeric tokens, identities, new claims, tool calls, or a payment action.
export function createFactExplainer({ generate }) {
  return async (statements) => {
    const ids = Object.keys(statements);
    const output = await generate({
      instructions: 'Explain the supplied financial facts by choosing an order for ALL supplied statement IDs. Return each ID exactly once. The factual sentences are computed by application code. Do not calculate, alter, or invent figures. You have no tools or authority to act. Return only schema JSON.',
      input: { statements },
      schema: { type: 'object', additionalProperties: false, required: ['statementIds'], properties: {
        statementIds: { type: 'array', minItems: ids.length, maxItems: ids.length, items: { type: 'string', enum: ids } },
      } },
    });
    if (!output || Object.keys(output).length !== 1 || !Array.isArray(output.statementIds) ||
        output.statementIds.length !== ids.length || new Set(output.statementIds).size !== ids.length ||
        output.statementIds.some((id) => !ids.includes(id))) {
      throw new HttpError(502, 'INVALID_ASSISTANT_OUTPUT', 'Split could not explain these facts safely. Try again.');
    }
    // The data window always leads an insight, even if the model orders it last.
    const order = statements.window ? ['window', ...output.statementIds.filter((id) => id !== 'window')] : output.statementIds;
    return order.map((id) => statements[id]).join(' ');
  };
}

export function createFinancialAnswers({ withTransaction, explain, now = () => new Date() }) {
  return async ({ actor, intent, query }) => {
    const facts = await readFinancialFacts({ withTransaction, actorId: actor.userId, query, now: now() });
    const plan = intent === 'affordability' ? affordabilityPlan(facts) : null;
    const answer = await explain(answerStatements(intent, facts, plan));
    return { type: 'answer', intent, answer, asOf: facts.asOf, balanceAsOf: facts.funds.balanceAsOf,
      ...(plan ? { plan } : intent === 'debt_summary' ? { groups: facts.groups, debts: facts.debts } : { spending: facts.spending }),
    };
  };
}
