import { apiRequest, getSession } from '../../api/session.js';
import { preserveFocus } from '../../lib/focus.js';

export function createGuard({ root, state, icon, esc, heading, render, announce, openGroup }) {
  const actorId = getSession()?.actor.userId;
  const owned = () => !!actorId && getSession()?.actor.userId === actorId;
  let events = [], error = '', loaded = false, loading = false, enabled = true, settingBusy = false;
  let tab = 'flagged', before = null, nextCursor = null, flaggedThisWeek = 0, feedbackBusy = null;
  let controller, version = 0, fingerprint = '', settingsLoaded = false;
  const refreshView = () => { if (owned() && state.page === 'guard') preserveFocus(root, render); };
  function invalidate() {
    version++; controller?.abort(); loading = false; loaded = false; error = ''; before = null; settingsLoaded = false; events = []; nextCursor = null;
  }
  async function load() {
    if (loading || !owned()) return;
    loading = true; error = ''; const token = ++version, request = new AbortController(); controller = request;
    const params = new URLSearchParams({ filter: tab }); if (before) params.set('before', before);
    try {
      const [data, settings] = await Promise.all([
        apiRequest(`/api/guard/events?${params}`, { signal: request.signal }),
        settingsLoaded ? null : apiRequest('/api/guard/settings', { signal: request.signal }),
      ]);
      if (token !== version || !owned()) return;
      events = data.events; nextCursor = data.nextCursor; flaggedThisWeek = data.summary.flaggedThisWeek; loaded = true;
      if (settings) { enabled = settings.enabled; settingsLoaded = true; }
    } catch (failure) {
      if (request.signal.aborted || token !== version) return;
      if (!owned()) { reset(); return; }
      error = 'Guard activity could not be loaded. Try again.';
    } finally { if (token === version) { loading = false; controller = null; refreshView(); } }
  }
  function guard() {
    if (!loaded && !error && !loading) void load();
    const content = events.map((event) => `<article class="log-item ${event.status === 'blocked' || event.status === 'flagged' ? 'blocked' : 'allowed'}">
      <span class="log-icon" aria-hidden="true">${event.status === 'flagged' ? '⚠' : icon(event.status === 'blocked' ? 'shield-x' : 'check')}</span>
      <div class="log-body"><h3>${esc(event.reason)}</h3><p class="small muted">${esc(event.groupName || event.source)} · ${esc(new Date(event.createdAt).toLocaleString())}</p>
      ${event.commentId ? `<blockquote class="guard-comment"><strong>${esc(event.authorName)}</strong><p>${esc(event.commentText)}</p></blockquote>
        <div class="guard-feedback"><button type="button" class="secondary" data-guard-feedback="ham" data-guard-id="${esc(event.id)}" ${feedbackBusy ? 'disabled' : ''}>Not spam</button>
        <button type="button" class="secondary" data-guard-feedback="spam" data-guard-id="${esc(event.id)}" ${feedbackBusy ? 'disabled' : ''}>${event.feedback === 'spam' ? 'Reported' : 'Report'}</button>
        <button type="button" class="text-button" data-guard-comment="${esc(event.id)}">View comment</button></div>` : ''}</div></article>`).join('');
    return heading('Guard', 'A second look, when it matters.', `${flaggedThisWeek} flagged this week`) +
      `<section class="guard-hero"><span class="guard-seal">${icon('shield-check')}</span><div><h2>Payment approval stays required.</h2>
      <p>Comment alerts are ${enabled ? 'on' : 'off'} for you. Group warning badges stay visible.</p>
      <label class="guard-setting"><input type="checkbox" id="sp-guard-alerts" ${enabled ? 'checked' : ''} ${settingBusy ? 'disabled' : ''}>Comment scam and spam alerts</label></div></section>
      <div class="log-filters" role="group" aria-label="Guard activity tabs">${[['flagged', 'Flagged'], ['held', 'Held'], ['blocked', 'Blocked'], ['approved', 'Approved']]
        .map(([value, label]) => `<button type="button" id="sp-guard-tab-${value}" class="filter" data-guard-tab="${value}" aria-pressed="${tab === value}">${label}</button>`).join('')}</div>
      ${error ? `<p role="alert">${esc(error)}</p><button type="button" class="text-button" data-guard-action="retry">Try again</button>` : ''}
      ${loading ? '<p role="status">Loading Guard activity…</p>' : ''}${content || (!loading && !error ? '<p>No activity in this tab.</p>' : '')}
      <div class="guard-feedback">${before ? `<button type="button" class="text-button" data-guard-action="latest" ${loading ? 'disabled' : ''}>Latest</button>` : ''}${nextCursor ? `<button type="button" class="text-button" data-guard-action="older" ${loading ? 'disabled' : ''}>Older</button>` : ''}</div>`;
  }
  root.addEventListener('change', async (event) => {
    if (event.target.id !== 'sp-guard-alerts' || settingBusy || !owned()) return;
    const desired = event.target.checked; settingBusy = true; refreshView();
    try {
      const settings = await apiRequest('/api/guard/settings', { method: 'POST', body: { enabled: desired } });
      if (owned()) { enabled = settings.enabled; announce(enabled ? 'Comment alerts enabled.' : 'Comment alerts paused for you. Payment approval stays required.'); }
    } catch { if (owned()) error = 'Your alert setting could not be saved. Try again.'; else reset(); }
    finally { settingBusy = false; refreshView(); }
  });
  root.addEventListener('click', async (event) => {
    const button = event.target.closest('button'); if (!button || !owned()) return;
    if (button.dataset.guardTab) { tab = button.dataset.guardTab; invalidate(); refreshView(); }
    else if (button.dataset.guardAction) {
      if (button.dataset.guardAction === 'older') before = nextCursor;
      if (button.dataset.guardAction === 'latest') before = null;
      version++; controller?.abort(); loading = false; loaded = false; error = ''; refreshView();
    } else if (button.dataset.guardComment) {
      const entry = events.find((item) => item.id === button.dataset.guardComment);
      if (entry) openGroup(entry.groupId, { expenseId: entry.expenseId, commentId: entry.commentId, focus: true });
    } else if (button.dataset.guardFeedback && !feedbackBusy) {
      const entry = events.find((item) => item.id === button.dataset.guardId); if (!entry) return;
      feedbackBusy = entry.id; refreshView();
      try {
        await apiRequest(`/api/guard/events/${encodeURIComponent(entry.id)}/feedback`, { method: 'POST', body: { label: button.dataset.guardFeedback } });
        if (owned()) { announce('Feedback saved.'); version++; controller?.abort(); loading = false; await load(); }
      } catch { if (owned()) error = 'Feedback could not be saved. Try again.'; else reset(); }
      finally { feedbackBusy = null; refreshView(); }
    }
  });
  function reset() {
    invalidate(); events = []; flaggedThisWeek = 0; enabled = true; fingerprint = '';
    if (state.page === 'guard') root.querySelector('#sp-view').replaceChildren();
  }
  root.addEventListener('click', (event) => { if (event.target.closest('#sp-logout')) reset(); }, true);
  window.addEventListener('pagehide', reset, { once: true });
  window.addEventListener('pageshow', (event) => { if (event.persisted && owned() && state.page === 'guard') { invalidate(); refreshView(); } });
  return { guard, invalidate, onNotifications(items) {
    if (!owned() || state.page !== 'guard' || document.hidden) return;
    const next = items.filter((item) => item.kind.startsWith('guard_')).map((item) => item.id).join(',');
    if (next !== fingerprint && !loading) { fingerprint = next; void load(); }
  } };
}
