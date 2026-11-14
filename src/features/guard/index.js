import { apiRequest, getSession } from '../../api/session.js';
import { preserveFocus } from '../../lib/focus.js';
import { avatarHtml } from '../../lib/avatar.js';
import { relativeTime } from '../notifications/presentation.js';

// B16 · Short labels for Guard's reasons (full sentences live in shared/guard-reasons.js).
const REASON_LABELS = Object.freeze({
  PROMPT_OVERRIDE: 'Tries to instruct the AI',
  OUTSIDE_PAYMENT: 'Asks for payment outside Split',
  CREDENTIAL_REQUEST: 'Asks for a password or code',
  SPAM_PATTERN: 'Reads like spam',
});
const TABS = [['flagged', 'Flagged'], ['held', 'Held'], ['blocked', 'Blocked'], ['approved', 'Approved']];
const EMPTY = {
  flagged: ['shield-check', 'Nothing flagged', 'When a message in one of your group chats looks like a scam or asks for money outside Split, it shows up here with the reason.'],
  held: ['calendar-clock', 'Nothing held', 'Payments you approved that are still waiting on the bank show up here.'],
  blocked: ['shield-x', 'Nothing blocked', 'Requests Guard refused, like an instruction to move money without your approval, show up here.'],
  approved: ['check', 'No approvals yet', 'Expenses you confirmed and payments you approved show up here.'],
};

export function createGuard({ root, state, icon, esc, heading, render, announce, openGroup }) {
  const actorId = getSession()?.actor.userId;
  const owned = () => !!actorId && getSession()?.actor.userId === actorId;
  let events = [], error = '', loaded = false, loading = false, enabled = true, settingBusy = false;
  let tab = 'flagged', before = null, nextCursor = null, flaggedThisWeek = 0, feedbackBusy = null;
  let controller, version = 0, fingerprint = '', settingsLoaded = false;
  const revealed = new Set();
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
  function flaggedItem(event) {
    const who = event.isAuthor ? 'You' : event.authorName || 'Someone';
    const codes = Array.isArray(event.reasonCodes) && event.reasonCodes.length ? event.reasonCodes : null;
    const tags = codes
      ? codes.map((code) => `<span class="guard-reason">${esc(REASON_LABELS[code] ?? code)}</span>`).join('')
      : `<span class="guard-reason">${esc(event.reason)}</span>`;
    const score = Number.isFinite(event.confidence) ? `<span class="small muted">Spam score ${Math.round(event.confidence * 100)}%</span>` : '';
    const shown = revealed.has(event.id);
    const state = event.feedback === 'ham' ? '<span class="guard-state">Marked safe</span>' : event.feedback === 'spam' ? '<span class="guard-state is-reported">Reported</span>' : '';
    return `<article class="guard-item is-flagged" aria-label="Flagged message from ${esc(who)} in ${esc(event.groupName || 'a group')}">
      <header class="guard-item-head">${event.authorUserId ? avatarHtml({ userId: event.authorUserId, displayName: event.authorName || '?' }, { label: false }) : ''}
        <div><p><strong>${esc(who)}</strong> in <strong>${esc(event.groupName || 'a group')}</strong></p>
        <p class="small muted"><time datetime="${esc(event.createdAt)}" title="${esc(new Date(event.createdAt).toLocaleString())}">${esc(relativeTime(event.createdAt))}</time>${event.isAuthor ? ' · others in the group see this warning' : ''}</p></div>${state}</header>
      <div class="guard-reasons">${tags}${score}</div>
      <button type="button" class="guard-message ${shown ? '' : 'is-hidden'}" data-guard-reveal="${esc(event.id)}" aria-expanded="${shown}">
        <span class="guard-message-text">${esc(event.commentText ?? '')}</span>${shown ? '' : '<span class="guard-message-cover">Tap to show the message</span>'}</button>
      <div class="guard-actions"><button type="button" class="primary" data-guard-comment="${esc(event.id)}">${icon('message-circle')}View in chat</button>
        ${event.isAuthor ? '' : `<button type="button" class="secondary" data-guard-feedback="ham" data-guard-id="${esc(event.id)}" ${feedbackBusy ? 'disabled' : ''}>Not spam</button>
        <button type="button" class="secondary is-danger" data-guard-feedback="spam" data-guard-id="${esc(event.id)}" ${feedbackBusy || event.feedback === 'spam' ? 'disabled' : ''}>${event.feedback === 'spam' ? 'Reported' : 'Report'}</button>`}</div>
    </article>`;
  }

  function otherItem(event) {
    const symbol = event.status === 'blocked' ? 'shield-x' : event.status === 'held' ? 'calendar-clock' : 'check';
    return `<article class="guard-item is-${esc(event.status)}"><span class="guard-item-icon">${icon(symbol)}</span>
      <div><p><strong>${esc(event.reason)}</strong></p><p class="small muted">${esc(event.groupName || event.source)} · <time datetime="${esc(event.createdAt)}">${esc(relativeTime(event.createdAt))}</time></p></div></article>`;
  }

  function guard() {
    if (!loaded && !error && !loading) void load();
    const items = events.map((event) => (event.commentId ? flaggedItem(event) : otherItem(event))).join('');
    const [emptyIcon, emptyTitle, emptyText] = EMPTY[tab];
    const toggle = `<label class="guard-toggle"><input type="checkbox" id="sp-guard-alerts" ${enabled ? 'checked' : ''} ${settingBusy ? 'disabled' : ''}><span>Chat alerts ${enabled ? 'on' : 'off'}</span></label>`;
    return heading('Guard', 'What Guard caught', '', toggle) +
      `<section class="guard-status">${icon('shield-check')}<div><p><strong>${flaggedThisWeek} ${flaggedThisWeek === 1 ? 'message' : 'messages'} flagged this week</strong> in your group chats.</p>
        <p class="small muted">Guard reads group chat messages for scams and requests to pay outside Split. Payments always need your approval.</p></div></section>
      <div class="log-filters guard-tabs" role="group" aria-label="Guard activity tabs">${TABS
        .map(([value, label]) => `<button type="button" id="sp-guard-tab-${value}" class="filter" data-guard-tab="${value}" aria-pressed="${tab === value}">${label}</button>`).join('')}</div>
      ${error ? `<div class="sp-error" role="alert">${icon('info')}<p>${esc(error)}</p><button type="button" class="secondary" data-guard-action="retry">Try again</button></div>` : ''}
      ${loading && !items ? `<div class="sp-card" role="status" aria-label="Loading Guard activity">${'<div class="sp-skeleton-row"><span class="sp-skeleton sp-skeleton-dot"></span><span class="sp-skeleton sp-skeleton-line"></span><span></span></div>'.repeat(3)}</div>` : ''}
      ${items ? `<div class="guard-list">${items}</div>` : !loading && !error ? `<div class="sp-empty">${icon(emptyIcon)}<h2>${emptyTitle}</h2><p>${emptyText}</p></div>` : ''}
      <div class="guard-pages">${before ? `<button type="button" class="text-button" data-guard-action="latest" ${loading ? 'disabled' : ''}>Latest</button>` : ''}${nextCursor ? `<button type="button" class="text-button" data-guard-action="older" ${loading ? 'disabled' : ''}>Older</button>` : ''}</div>`;
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
    if (button.dataset.guardReveal) {
      const id = button.dataset.guardReveal;
      if (revealed.has(id)) revealed.delete(id); else revealed.add(id);
      refreshView();
    } else if (button.dataset.guardTab) { tab = button.dataset.guardTab; invalidate(); refreshView(); }
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
