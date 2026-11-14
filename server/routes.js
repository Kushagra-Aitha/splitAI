// F3 mounts the agreed endpoints. Feature owners supply handlers after F4.
// Handler context: { actor, body, params, query, requestId }. Identity comes
// exclusively from actor; body names/IDs are untrusted feature input.
export const routes = Object.freeze([
  ['groups.list', 'GET', '/api/groups'],
  ['groups.create', 'POST', '/api/groups'],
  ['groups.addMember', 'POST', '/api/groups/:id/members'],
  ['groups.leave', 'POST', '/api/groups/:id/leave'],
  ['groups.get', 'GET', '/api/groups/:id'],
  ['activity.list', 'GET', '/api/groups/:id/activity'],
  ['comments.create', 'POST', '/api/groups/:id/comments'],
  ['expenseDrafts.create', 'POST', '/api/expense-drafts'],
  ['expenseDrafts.confirm', 'POST', '/api/expense-drafts/:id/confirm'],
  ['settlementReviews.create', 'POST', '/api/settlement-reviews'],
  ['settlementReviews.confirm', 'POST', '/api/settlement-reviews/:id/confirm'],
  ['settlements.get', 'GET', '/api/settlements/:id'],
  ['guard.list', 'GET', '/api/guard/events'],
  ['notifications.list', 'GET', '/api/notifications'],
  ['notifications.read', 'POST', '/api/notifications/read'],
  ['banking.sync', 'POST', '/api/banking/sync'],
  ['banking.connect', 'POST', '/api/banking/connect'],
  ['overview.get', 'GET', '/api/overview'],
  ['ask.create', 'POST', '/api/ask'],
  ['insight.get', 'GET', '/api/insight'],
  ['goals.list', 'GET', '/api/goals'],
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
