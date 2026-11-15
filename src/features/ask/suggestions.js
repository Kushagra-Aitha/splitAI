const FALLBACKS = ['Show my recent transactions', 'Where is my spending concentrated this month?',
  'What do I owe?', 'How are my goals doing?', 'Help me record a shared expense'];

export function buildAskPrompts({ topics = [], groups = [], transactions = [], goals = [] } = {}) {
  const latestTopic = topics.at(-1);
  const recent = transactions.find((transaction) => typeof transaction?.merchantName === 'string' && transaction.merchantName.trim());
  const group = groups.find((item) => typeof item?.name === 'string' && item.name.trim());
  const goal = goals.find((item) => typeof item?.name === 'string' && item.name.trim());
  const candidates = [
    latestTopic?.merchant ? `Show more transactions from ${latestTopic.merchant}` : null,
    latestTopic?.category ? `How is my ${latestTopic.category} spending?` : null,
    recent?.merchantName ? `Explain my ${recent.merchantName} charge` : null,
    recent?.merchantName && group?.name ? `Split my last ${recent.merchantName} card purchase with ${group.name}` : null,
    goal?.name ? `How am I doing on my ${goal.name} goal?` : null,
    group?.name ? `Help me record an expense for ${group.name}` : null,
    ...FALLBACKS,
  ].filter((value) => typeof value === 'string' && value.length <= 120);
  return [...new Set(candidates)].slice(0, 5);
}
