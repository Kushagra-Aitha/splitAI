import { apiRequest } from '../../api/session.js';

export function createGuard({ root, state, icon, esc, heading, render }) {
  let events;
  let error;
  let loading = false;

  async function load() {
    loading = true;
    try {
      ({ events } = await apiRequest('/api/guard/events'));
    } catch (failure) {
      error = failure.message;
    } finally {
      loading = false;
      if (state.page === 'guard') render();
    }
  }

  function invalidate() {
    events = undefined;
    error = undefined;
  }

  function guard() {
    if (!events && !error && !loading) void load();
    const visible = events?.filter((event) => state.filter === 'all' || event.decision === state.filter);
    const content = error
      ? `<p role="alert">${esc(error)}</p><button type="button" data-action="guard-retry">Retry</button>`
      : visible
        ? visible.map((event) => `
          <article class="log-item ${event.decision === 'blocked' ? 'blocked' : 'allowed'}">
            <span class="log-icon">${icon(event.decision === 'blocked' ? 'shield-x' : 'check')}</span>
            <div class="log-body">
              <h3>${esc(event.reason)}</h3>
              <p>${esc(event.source)} · ${esc(new Date(event.createdAt).toLocaleString())}</p>
              <p class="small">Event ID: <code>${esc(event.id)}</code></p>
            </div>
          </article>`).join('') || '<p>No Guard activity for this filter.</p>'
        : '<p role="status">Loading Guard activity…</p>';
    return heading('Guard', 'Activity log', 'Review what you approved and what Guard blocked.') +
      `<div class="guard-hero"><span class="guard-seal">${icon('shield-check')}</span>
        <div><h2>Guard is on</h2><p>Payments require your approval.</p></div></div>
        <div class="log-filters">${[['all', 'All activity'], ['blocked', 'Blocked'], ['allowed', 'Approved']]
          .map(([value, label]) => `<button type="button" class="filter" data-guard-filter="${value}"
            aria-pressed="${state.filter === value}">${label}</button>`).join('')}</div>${content}`;
  }

  root.addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (button?.dataset.guardFilter) {
      state.filter = button.dataset.guardFilter;
      render();
    } else if (button?.dataset.action === 'guard-retry') {
      invalidate();
      render();
    }
  });

  return { guard, invalidate };
}
