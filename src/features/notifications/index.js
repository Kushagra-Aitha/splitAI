import { apiRequest, getSession } from '../../api/session.js';
import { preserveFocus } from '../../lib/focus.js';
import { avatarHtml } from '../../lib/avatar.js';
import { notificationMessage, relativeTime } from './presentation.js';

const INTERVAL = 15_000;

export function createNotifications({ root, icon, icons, esc, announce, go, openGroup, onRefresh }) {
  const host = root.querySelector('#sp-notifications');
  const actorId = getSession()?.actor.userId;
  let items = [], unreadCount = 0, nextCursor = null, before = null;
  let open = false, loading = false, error = '', reading = false, stopped = false;
  let timer, pending, readController, epoch = 0, pollId = 0;
  const owned = () => !!actorId && getSession()?.actor.userId === actorId;

  // B16 · Grouped Today / Earlier; bold actor; unread = tint + dot + bold;
  // every row is one button with a chevron so it reads as clickable.
  const dayKey = (value) => new Date(value).toDateString();
  const GUARD_KINDS = new Set(['guard_flagged', 'guard_blocked']);
  function itemHtml(item) {
    const message = esc(notificationMessage(item));
    const actor = item.actorName ? esc(item.actorName) : '';
    const text = actor && message.startsWith(actor) ? `<strong>${actor}</strong>${message.slice(actor.length)}` : message;
    const leading = GUARD_KINDS.has(item.kind)
      ? `<span class="notification-icon is-guard">${icon(item.kind === 'guard_blocked' ? 'shield-x' : 'shield-alert')}</span>`
      : item.actorUserId ? avatarHtml({ userId: item.actorUserId, displayName: item.actorName }, { label: false }) : `<span class="notification-icon">${icon('bell')}</span>`;
    const meta = [item.groupName ? esc(item.groupName) : null, esc(relativeTime(item.createdAt))].filter(Boolean).join(' · ');
    return `<li><button type="button" id="sp-notification-${esc(item.id)}" class="notification-item ${item.readAt ? 'is-read' : 'is-unread'}" data-notification-id="${esc(item.id)}" ${reading ? 'disabled' : ''}>
      ${leading}<span class="notification-copy"><span class="notification-text">${text}</span><time class="notification-meta" datetime="${esc(item.createdAt)}" title="${esc(new Date(item.createdAt).toLocaleString())}">${meta}</time></span>
      ${item.readAt ? '' : '<span class="notification-dot" aria-hidden="true"></span><span class="sr-only">Unread.</span>'}${icon('chevron-right')}</button></li>`;
  }
  function groupsHtml() {
    const today = dayKey(Date.now());
    const sections = [['Today', items.filter((i) => dayKey(i.createdAt) === today)], ['Earlier', items.filter((i) => dayKey(i.createdAt) !== today)]];
    return sections.filter(([, list]) => list.length)
      .map(([label, list]) => `<h3 class="notification-section">${label}</h3><ul>${list.map(itemHtml).join('')}</ul>`).join('');
  }
  function render() {
    preserveFocus(host, () => {
      host.innerHTML = `<button type="button" id="sp-notification-bell" class="icon-button notification-bell" aria-label="Notifications, ${unreadCount} unread" aria-expanded="${open}" aria-controls="sp-notification-panel">${icon('bell')}${unreadCount ? `<span class="notification-badge" aria-hidden="true">${unreadCount > 99 ? '99+' : unreadCount}</span>` : ''}</button>
        ${open ? `<section id="sp-notification-panel" class="notification-panel" aria-label="Notifications"><div class="notification-heading"><h2>Notifications</h2><button type="button" id="sp-notification-read-all" class="text-button" data-notification-action="read-all" ${reading || !unreadCount ? 'disabled' : ''}>Mark all read</button></div>
        ${error ? `<p class="notification-error" role="alert">${esc(error)} <button type="button" class="text-button" data-notification-action="retry">Retry</button></p>` : ''}
        ${reading ? '<p class="notification-status" role="status">Opening…</p>' : ''}
        ${items.length ? groupsHtml() : loading ? '<p class="notification-status" role="status">Checking notifications…</p>' : !error ? `<div class="notification-empty">${icon('bell')}<p>You’re all caught up.</p></div>` : ''}
        <div class="notification-pages">${before ? '<button type="button" class="text-button" data-notification-action="latest">Latest</button>' : ''}${nextCursor ? `<button type="button" class="text-button" data-notification-action="older" ${loading ? 'disabled' : ''}>Older</button>` : ''}</div></section>` : ''}`;
      icons();
    });
  }
  function cancelPoll() {
    clearTimeout(timer);
    pollId++;
    pending?.abort(); pending = null; loading = false;
  }
  function stop() {
    stopped = true; epoch++;
    cancelPoll(); readController?.abort();
    items = []; unreadCount = 0; nextCursor = null; before = null;
    open = false; error = ''; reading = false; render();
  }
  async function refresh() {
    if (stopped || document.hidden || loading) return;
    if (!owned()) { stop(); return; }
    clearTimeout(timer);
    const token = ++pollId;
    const started = Date.now();
    const controller = new AbortController();
    pending = controller; loading = true; error = ''; render();
    try {
      const data = await apiRequest(`/api/notifications${before ? `?before=${encodeURIComponent(before)}` : ''}`, { signal: controller.signal });
      if (token !== pollId || stopped) return;
      if (!owned()) { stop(); return; }
      items = data.items; unreadCount = data.unreadCount; nextCursor = data.nextCursor;
      onRefresh?.(items);
    } catch (failure) {
      if (token !== pollId || controller.signal.aborted) return;
      if (!owned() || failure.status === 401) { stop(); return; }
      error = 'Notifications could not be refreshed. Try again.';
    } finally {
      if (token === pollId && !stopped) {
        pending = null; loading = false; render();
        if (!document.hidden) timer = setTimeout(() => void refresh(), error ? 30_000 : Math.max(0, INTERVAL - (Date.now() - started)));
      }
    }
  }
  async function openItem(item) {
    if (reading || stopped || !owned()) return;
    reading = true; error = '';
    const token = epoch;
    readController = new AbortController(); render();
    try {
      await apiRequest('/api/notifications/read', { method: 'POST', body: { ids: [item.id] }, signal: readController.signal });
      if (token !== epoch || stopped || !owned()) return;
      open = false; cancelPoll(); render();
      void refresh();
      if (item.kind === 'guard_blocked') go('guard');
      else if (item.groupId) openGroup(item.groupId, {
        expenseId: item.expenseId, settlementId: item.kind.startsWith('settlement_') ? item.sourceId : item.settlementId,
        commentId: ['comment_added', 'guard_flagged'].includes(item.kind) ? item.sourceId : null, focus: true,
      });
    } catch (failure) {
      if (token !== epoch || readController.signal.aborted) return;
      if (!owned() || failure.status === 401) { stop(); return; }
      error = 'This notification could not be opened. Try again.'; announce(error);
    } finally {
      if (token === epoch && !stopped) { reading = false; readController = null; render(); }
    }
  }
  async function markAllRead() {
    if (reading || stopped || !owned()) return;
    reading = true; error = ''; const token = epoch;
    const controller = new AbortController(); readController = controller; render();
    try {
      await apiRequest('/api/notifications/read', { method: 'POST', body: { all: true }, signal: controller.signal });
      if (token !== epoch || stopped || !owned()) return;
      cancelPoll(); announce('Notifications marked read.'); void refresh();
    } catch (failure) {
      if (token !== epoch || controller.signal.aborted) return;
      if (!owned() || failure.status === 401) { stop(); return; }
      error = 'Notifications could not be marked read. Try again.';
    } finally { if (token === epoch && !stopped) { reading = false; readController = null; render(); } }
  }
  host.addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.id === 'sp-notification-bell') {
      open = !open; render();
      if (open) { void refresh(); host.querySelector('.notification-item')?.focus({ preventScroll: true }); }
    } else if (button.dataset.notificationId) {
      const item = items.find((value) => value.id === button.dataset.notificationId);
      if (item) void openItem(item);
    } else if (button.dataset.notificationAction) {
      if (button.dataset.notificationAction === 'read-all') { void markAllRead(); return; }
      if (button.dataset.notificationAction === 'older') before = nextCursor;
      if (button.dataset.notificationAction === 'latest') before = null;
      cancelPoll(); void refresh();
    }
  });
  const outside = (event) => { if (open && !host.contains(event.target)) { open = false; render(); } };
  const escape = (event) => {
    if (open && event.key === 'Escape') {
      event.preventDefault(); open = false; render(); host.querySelector('#sp-notification-bell')?.focus({ preventScroll: true });
    }
  };
  const visibility = () => { cancelPoll(); if (document.hidden) { open = false; render(); } else void refresh(); };
  const logout = (event) => { if (event.target.closest('#sp-logout')) stop(); };
  document.addEventListener('pointerdown', outside);
  document.addEventListener('keydown', escape);
  document.addEventListener('visibilitychange', visibility);
  root.addEventListener('click', logout);
  window.addEventListener('pagehide', stop, { once: true });
  render(); void refresh();
  return { refresh, destroy() {
    stop(); document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape);
    document.removeEventListener('visibilitychange', visibility); root.removeEventListener('click', logout);
    window.removeEventListener('pagehide', stop);
  } };
}
