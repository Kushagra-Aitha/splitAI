// B10 · Hash routes. The URL is the source of truth for the current page, so
// refresh, Back/Forward and copied links keep your place.
//
//   #/overview  #/transactions  #/groups  #/groups/<uuid>
//   #/goals     #/insights      #/guard   #/ask
//
// Page keys (`home`, `profile`, `chat`, …) are the feature modules' existing
// state.page values; routes are the user-facing names.

const ROUTE_TO_PAGE = Object.freeze({
  overview: 'home',
  transactions: 'transactions',
  groups: 'groups',
  goals: 'goals',
  insights: 'profile',
  guard: 'guard',
  ask: 'chat',
});
const PAGE_TO_ROUTE = Object.freeze(Object.fromEntries(Object.entries(ROUTE_TO_PAGE).map(([route, page]) => [page, route])));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const PAGE_TITLES = Object.freeze({
  home: 'Overview',
  transactions: 'Transactions',
  groups: 'Groups',
  goals: 'Goals',
  profile: 'Insights',
  guard: 'Guard',
  chat: 'Ask Split',
});

/** `#/groups/<id>` → { page: 'groups', group: '<id>' }. Unknown routes → Overview. */
export function parseHash(hash = '') {
  const [route = '', id = '', ...rest] = String(hash).replace(/^#\/?/, '').split('/').filter(Boolean);
  const page = ROUTE_TO_PAGE[route.toLowerCase()];
  if (!page || rest.length) return { page: 'home', group: null };
  if (page === 'groups' && id) return UUID.test(id) ? { page, group: id.toLowerCase() } : { page, group: null };
  if (id) return { page: 'home', group: null };
  return { page, group: null };
}

/** The canonical hash for a page state. */
export function hashFor({ page, group } = {}) {
  const route = PAGE_TO_ROUTE[page] ?? 'overview';
  return `#/${route}${route === 'groups' && group && UUID.test(group) ? `/${group.toLowerCase()}` : ''}`;
}
