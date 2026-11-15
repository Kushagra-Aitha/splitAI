const FALLBACKS = [
  { id: 'tx-recent', label: 'Show my recent transactions',
    action: { type: 'transactions', merchant: null, category: null, from: null, to: null } },
  { id: 'spend-month', label: 'Where is my spending concentrated this month?',
    action: { type: 'spending_guidance', category: null, from: null, to: null } },
  { id: 'debt', label: 'What do I owe?', action: { type: 'debt_summary' } },
  { id: 'goals', label: 'How are my goals doing?', action: { type: 'goal_progress' } },
  { id: 'expense-help', label: 'Help me record a shared expense',
    action: { type: 'expense_help', groupName: null } },
];

function prompt(id, label, action) {
  if (typeof label !== 'string' || !label || label.length > 120) return null;
  return { id, label, action };
}

function followUps(latest, { group, goal, recent }) {
  const merchant = latest?.merchant || null;
  const category = latest?.category || null;
  const from = latest?.from || null;
  const to = latest?.to || null;
  switch (latest?.intent) {
    case 'explain_charge':
      return [
        merchant && group?.name
          ? prompt(`split-${merchant}-${group.name}`, `Split my last ${merchant} card purchase with ${group.name}`,
            { type: 'bank_split', merchant, groupName: group.name })
          : null,
        merchant
          ? prompt(`tx-merchant-${merchant}`, `Show more transactions from ${merchant}`,
            { type: 'transactions', merchant, category: null, from, to })
          : null,
        category
          ? prompt(`spend-${category}`, `How is my ${category} spending?`,
            { type: 'spending_guidance', category, from, to })
          : prompt('spend-month', 'Where is my spending concentrated this month?',
            { type: 'spending_guidance', category: null, from: null, to: null }),
        prompt('debt', 'What do I owe?', { type: 'debt_summary' }),
      ];
    case 'transactions':
      return [
        merchant
          ? prompt(`explain-${merchant}`, `Explain my ${merchant} charge`,
            { type: 'explain_charge', merchant })
          : (recent?.merchantName
            ? prompt(`explain-${recent.merchantName}`, `Explain my ${recent.merchantName} charge`,
              { type: 'explain_charge', merchant: recent.merchantName })
            : null),
        merchant && group?.name
          ? prompt(`split-${merchant}-${group.name}`, `Split my last ${merchant} card purchase with ${group.name}`,
            { type: 'bank_split', merchant, groupName: group.name })
          : null,
        category
          ? prompt(`spend-${category}`, `How is my ${category} spending?`,
            { type: 'spending_guidance', category, from, to })
          : null,
        prompt('spend-month', 'Where is my spending concentrated this month?',
          { type: 'spending_guidance', category: null, from: null, to: null }),
      ];
    case 'spending_guidance':
      return [
        category
          ? prompt(`tx-cat-${category}`, `Show my recent ${category} transactions`,
            { type: 'transactions', merchant: null, category, from, to })
          : prompt('tx-recent', 'Show my recent transactions',
            { type: 'transactions', merchant: null, category: null, from: null, to: null }),
        recent?.merchantName
          ? prompt(`explain-${recent.merchantName}`, `Explain my ${recent.merchantName} charge`,
            { type: 'explain_charge', merchant: recent.merchantName })
          : null,
        goal?.name
          ? prompt(`goal-${goal.name}`, `How am I doing on my ${goal.name} goal?`,
            { type: 'goal_progress' })
          : null,
        prompt('debt', 'What do I owe?', { type: 'debt_summary' }),
      ];
    case 'debt_summary':
      return [
        group?.name
          ? prompt(`expense-${group.name}`, `Help me record an expense for ${group.name}`,
            { type: 'expense_help', groupName: group.name })
          : null,
        prompt('tx-recent', 'Show my recent transactions',
          { type: 'transactions', merchant: null, category: null, from: null, to: null }),
        goal?.name
          ? prompt(`goal-${goal.name}`, `How am I doing on my ${goal.name} goal?`,
            { type: 'goal_progress' })
          : null,
      ];
    case 'goal_progress':
    case 'affordability':
      return [
        prompt('spend-month', 'Where is my spending concentrated this month?',
          { type: 'spending_guidance', category: null, from: null, to: null }),
        prompt('tx-recent', 'Show my recent transactions',
          { type: 'transactions', merchant: null, category: null, from: null, to: null }),
        prompt('debt', 'What do I owe?', { type: 'debt_summary' }),
      ];
    case 'expense':
    case 'reminder':
      return [
        prompt('debt', 'What do I owe?', { type: 'debt_summary' }),
        group?.name
          ? prompt(`expense-${group.name}`, `Help me record an expense for ${group.name}`,
            { type: 'expense_help', groupName: group.name })
          : null,
        merchant
          ? prompt(`explain-${merchant}`, `Explain my ${merchant} charge`,
            { type: 'explain_charge', merchant })
          : null,
      ];
    case 'payment_clarification':
      return [
        prompt('debt', 'What do I owe?', { type: 'debt_summary' }),
        prompt('tx-recent', 'Show my recent transactions',
          { type: 'transactions', merchant: null, category: null, from: null, to: null }),
        prompt('expense-help', 'Help me record a shared expense',
          { type: 'expense_help', groupName: null }),
      ];
    default:
      return [
        merchant
          ? prompt(`tx-merchant-${merchant}`, `Show more transactions from ${merchant}`,
            { type: 'transactions', merchant, category: null, from, to })
          : null,
        category
          ? prompt(`spend-${category}`, `How is my ${category} spending?`,
            { type: 'spending_guidance', category, from, to })
          : null,
      ];
  }
}

export function buildAskPrompts({ topics = [], groups = [], transactions = [], goals = [], exclude = [] } = {}) {
  const latest = topics.at(-1);
  const recent = transactions.find((transaction) => typeof transaction?.merchantName === 'string' && transaction.merchantName.trim());
  const group = groups.find((item) => typeof item?.name === 'string' && item.name.trim());
  const goal = goals.find((item) => typeof item?.name === 'string' && item.name.trim());
  const blocked = new Set(exclude.filter((value) => typeof value === 'string' && value.trim()));
  const profile = [
    !latest?.merchant && recent?.merchantName
      ? prompt(`explain-${recent.merchantName}`, `Explain my ${recent.merchantName} charge`,
        { type: 'explain_charge', merchant: recent.merchantName })
      : null,
    recent?.merchantName && group?.name && latest?.intent !== 'explain_charge'
      ? prompt(`split-${recent.merchantName}-${group.name}`,
        `Split my last ${recent.merchantName} card purchase with ${group.name}`,
        { type: 'bank_split', merchant: recent.merchantName, groupName: group.name })
      : null,
    goal?.name && latest?.intent !== 'goal_progress'
      ? prompt(`goal-${goal.name}`, `How am I doing on my ${goal.name} goal?`, { type: 'goal_progress' })
      : null,
    group?.name && !['expense', 'reminder'].includes(latest?.intent)
      ? prompt(`expense-${group.name}`, `Help me record an expense for ${group.name}`,
        { type: 'expense_help', groupName: group.name })
      : null,
  ];
  const candidates = [...followUps(latest, { group, goal, recent }), ...profile, ...FALLBACKS]
    .filter((item) => item && !blocked.has(item.label));
  const seen = new Set();
  const prompts = [];
  for (const item of candidates) {
    if (seen.has(item.label)) continue;
    seen.add(item.label);
    prompts.push(item);
    if (prompts.length === 5) break;
  }
  return prompts;
}
