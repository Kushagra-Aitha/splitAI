// F3 mounts the agreed endpoints. Feature owners supply handlers after F4.
// Handler context: { actor, body, params, query, requestId }. Identity comes
// exclusively from actor; body names/IDs are untrusted feature input.
export const routes = Object.freeze([
  ['bank.get', 'GET', '/api/bank'],
  ['bank.connect', 'POST', '/api/bank/connect'],
  ['bank.sync', 'POST', '/api/bank/sync'],
  ['bank.operations.create', 'POST', '/api/bank/operations'],
  ['bank.operations.get', 'GET', '/api/bank/operations/:id'],
  ['bank.schedules.create', 'POST', '/api/bank/schedules'],
  ['bank.schedules.update', 'POST', '/api/bank/schedules/:id'],
  ['bank.schedules.run', 'POST', '/api/bank/schedules/:id/run'],
  ['groups.list', 'GET', '/api/groups'],
  ['groups.create', 'POST', '/api/groups'],
  ['groups.update', 'POST', '/api/groups/:id/update'],
  ['groups.addMember', 'POST', '/api/groups/:id/members'],
  ['groups.leave', 'POST', '/api/groups/:id/leave'],
  ['charges.explain', 'GET', '/api/groups/:id/explain/:kind/:entryId'],
  ['groups.get', 'GET', '/api/groups/:id'],
  ['activity.list', 'GET', '/api/groups/:id/activity'],
  ['comments.create', 'POST', '/api/groups/:id/comments'],
  ['recurringSplits.list', 'GET', '/api/recurring-splits'],
  ['recurringSplits.create', 'POST', '/api/recurring-splits'],
  ['recurringSplits.update', 'POST', '/api/recurring-splits/:id'],
  ['expenseDrafts.create', 'POST', '/api/expense-drafts'],
  ['expenseDrafts.confirm', 'POST', '/api/expense-drafts/:id/confirm'],
  ['settlementReviews.create', 'POST', '/api/settlement-reviews'],
  ['settlementReviews.confirm', 'POST', '/api/settlement-reviews/:id/confirm'],
  ['settlements.get', 'GET', '/api/settlements/:id'],
  ['guard.list', 'GET', '/api/guard/events'],
  ['guard.feedback', 'POST', '/api/guard/events/:id/feedback'],
  ['guard.settings.get', 'GET', '/api/guard/settings'],
  ['guard.settings.update', 'POST', '/api/guard/settings'],
  ['notifications.list', 'GET', '/api/notifications'],
  ['notifications.read', 'POST', '/api/notifications/read'],
  ['banking.sync', 'POST', '/api/banking/sync'],
  ['banking.connect', 'POST', '/api/banking/connect'],
  ['banking.accounts', 'GET', '/api/banking/accounts'],
  ['banking.transactions', 'GET', '/api/banking/transactions'],
  ['banking.transactionCategory', 'POST', '/api/banking/transactions/:id/category'],
  ['overview.get', 'GET', '/api/overview'],
  ['ask.transcribe', 'POST', '/api/ask/transcribe'],
  ['ask.create', 'POST', '/api/ask'],
  ['reminders.draft', 'POST', '/api/reminders/drafts'],
  ['reminders.confirm', 'POST', '/api/reminders/:id/confirm'],
  ['insight.get', 'GET', '/api/insight'],
  ['insights.get', 'GET', '/api/insights'],
  ['goals.list', 'GET', '/api/goals'],
  ['goals.history', 'GET', '/api/goals/:id/history'],
  ['goals.create', 'POST', '/api/goals'],
  ['goals.move', 'POST', '/api/goals/:id/movements'],
].map(([name, method, path]) => Object.freeze({ name, method, path })));

export function matchRoutes(pathname) {
  const segments = pathname.split('/');
  return routes.flatMap((route) => {
    const parts = route.path.split('/');
    if (parts.length !== segments.length) return [];
    const params = Object.create(null);
    for (let i = 0; i < parts.length; i++) {
      if (parts[i].startsWith(':') && segments[i]) params[parts[i].slice(1)] = segments[i];
      else if (parts[i] !== segments[i]) return [];
    }
    return [{ ...route, params: Object.freeze(params) }];
  });
}
