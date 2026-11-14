import { apiRequest, getSession } from '../../api/session.js';
import { preserveFocus } from '../../lib/focus.js';
import { GUARD_REASONS } from '../../../shared/guard-reasons.js';

// Activity owns only its section. Refreshes never replace Together's ledger
// state, feed data never enters Ask, and comment drafts stay in memory only.
export function createActivity({ root, state, esc, money, announce }) {
  const actorId = getSession()?.actor.userId;
  let groupId = null, threadId = null, threadKind = null, host = null, items = [];
  let before = null, focus = null, nextCursor = null, loading = false, error = '', postError = '';
  let ledger = [], ledgerCursor = null, selectedTab = 'Activity', chatOpen = false, unread = 0;
  let controller, postController, generation = 0, posting = false, needsFocus = false, fingerprint = '';
  const drafts = new Map();
  const owned = () => !!actorId && getSession()?.actor.userId === actorId;
  const active = () => owned() && state.page === 'groups' && state.group === groupId && host?.isConnected;
  const draft = () => {
    const key = threadId || 'group';
    if (!drafts.has(key)) drafts.set(key, { text: '', requestKey: crypto.randomUUID() });
    return drafts.get(key);
  };
  const date = (value) => `<time class="small muted" datetime="${esc(value)}">${esc(new Date(value).toLocaleString())}</time>`;
  const threadButton = (id, kind, label) => `<button type="button" class="text-button" data-thread-id="${esc(id)}" data-thread-kind="${kind}">${label}</button>`;
  function entry(item) {
    let content;
    if (item.type === 'comment') content = `<p class="small"><strong>${esc(item.authorName)}</strong> commented</p>
      <p class="comment-text">${esc(item.text)}</p>${item.guardFlagged ? `<p class="comment-warning" role="note">⚠ Guard warning: ${esc((item.guardReasons || []).map((reason) => GUARD_REASONS[reason]).filter(Boolean).join(' '))}</p>` : ''}`;
    else if (item.type === 'expense') content = `<h3>${esc(item.merchant)} · ${money(item.amountCents)}</h3>
      <p class="small muted">Paid by ${esc(item.authorName)} · Your share ${money(item.yourShareCents)}</p>${threadButton(item.id, 'expense', `Comments (${item.commentCount ?? 0})`)}`;
    else content = `<h3>Settlement · ${money(item.amountCents)}</h3><p>${esc(item.authorName)} to ${esc(item.payeeName)} · ${esc(item.status)}</p>${threadButton(item.id, 'settlement', `Comments (${item.commentCount ?? 0})`)}`;
    return `<li><article id="sp-activity-${esc(item.id)}" data-ledger-entry="${esc(item.id)}" tabindex="-1" class="activity-entry">${content}${date(item.occurredAt)}${item.id === threadId ? '<div data-inline-thread></div>' : ''}</article></li>`;
  }
  function render() {
    if (!active()) return;
    preserveFocus(host, () => {
      const conversation = threadId || chatOpen ? `<div class="activity-heading"><h2 id="sp-activity-title" tabindex="-1">${threadId ? (threadKind === 'expense' ? 'Expense comments' : 'Settlement comments') : 'Group chat'}</h2>
        <div>${threadId ? '<button type="button" class="text-button" data-activity-action="group">Close thread</button>' : ''}
        <button type="button" id="sp-activity-refresh" class="text-button" data-activity-action="refresh" ${loading ? 'disabled' : ''}>Refresh</button></div></div>

        ${error ? `<p role="alert">${esc(error)}</p>` : ''}${loading ? '<p role="status">Loading activity…</p>' : ''}
        <ul class="activity-list">${items.map(entry).join('')}</ul>
        ${!items.length && !loading && !error ? `<p>${threadId ? 'No comments yet.' : 'No shared activity yet.'}</p>` : ''}
        <div class="activity-pages">${before || focus ? '<button type="button" class="text-button" data-activity-action="latest">Latest</button>' : ''}
        ${nextCursor ? `<button type="button" class="text-button" data-activity-action="older" ${loading ? 'disabled' : ''}>Older</button>` : ''}</div>
        <form id="sp-comment-form" class="field-grid">
          <label class="field">${threadId ? `Comment on this ${threadKind}` : 'Comment to the group'}
            <textarea id="sp-comment-text" name="text" rows="3" required aria-describedby="sp-comment-help" ${posting ? 'disabled' : ''}>${esc(draft().text)}</textarea></label>
          <p id="sp-comment-help" class="small muted">Up to 500 characters. Shared with this group's members.</p>
          <button type="submit" class="primary" ${posting ? 'disabled' : ''}>${posting ? 'Posting…' : 'Post comment'}</button>
          <p role="alert">${esc(postError)}</p>
        </form>` : '';
      host.innerHTML = `<section id="sp-group-panel-Activity" role="tabpanel" aria-labelledby="sp-group-tab-Activity" ${selectedTab === 'Activity' ? '' : 'hidden'}>
        ${!threadId && !chatOpen && error ? `<p role="alert">${esc(error)} <button type="button" class="text-button" data-activity-action="refresh">Retry</button></p>` : ''}
        <ul class="activity-list">${ledger.map(entry).join('')}</ul>
        ${!ledger.length && (loading ? !threadId && !chatOpen : !error) ? `<p>${loading ? 'Loading activity…' : 'No shared expenses yet.'}</p>` : ''}
        ${!threadId && !chatOpen && ledgerCursor ? `<button type="button" class="secondary" data-activity-action="ledger-older" ${loading ? 'disabled' : ''}>Load older activity</button>` : ''}
        </section>
        ${chatOpen ? `<aside class="group-chat-drawer" aria-label="Group chat">
          <button type="button" class="secondary" data-activity-action="close">Close chat</button>${conversation}</aside>` : ''}`;
      if (threadId) {
        const panel = host.querySelector('[data-inline-thread]');
        if (panel) panel.innerHTML = conversation;
      }
      const badge = root.querySelector('#sp-group-unread');
      if (badge) badge.textContent = unread ? `(${unread})` : '';

    });
  }
  function abortRead() { generation++; controller?.abort(); controller = null; loading = false; }
  function reset() {
    abortRead(); postController?.abort(); postController = null;
    ledger = []; ledgerCursor = null; chatOpen = false; unread = 0; groupId = null; threadId = null; threadKind = null; host = null; items = [];
    before = null; focus = null; nextCursor = null; error = ''; postError = '';
    drafts.clear(); posting = false; needsFocus = false; fingerprint = '';
  }
  async function refresh({ append = false } = {}) {
    if (!active() || document.hidden) return;
    abortRead();
    const token = generation, request = new AbortController(); controller = request;
    const params = new URLSearchParams();
    if (threadId) params.set(`${threadKind}Id`, threadId);
    else params.set('view', chatOpen ? 'chat' : 'ledger');
    if (before && (threadId || chatOpen || append)) params.set('before', before);
    else if (focus) { params.set('focusId', focus.id); params.set('focusType', focus.type); }
    loading = true; error = ''; render();
    try {
      const data = await apiRequest(`/api/groups/${encodeURIComponent(groupId)}/activity?${params}`, { signal: request.signal });
      if (token !== generation || !active()) return;
      items = data.items;
      if (!threadId && !chatOpen) {
        before = null;
        ledger = append || focus ? [...new Map([...ledger, ...items].map((item) => [item.id, item])).values()] : items;
        if (!focus) ledgerCursor = data.nextCursor;
      }
      if (threadId && !ledger.some((item) => item.id === threadId)) {
        const parent = data.expense
          ? { ...data.expense, amountCents: data.expense.totalCents, type: 'expense' }
          : data.settlement && { ...data.settlement, type: 'settlement' };
        if (parent) ledger = [parent, ...ledger];
      }
      nextCursor = data.nextCursor;
    } catch (failure) {
      if (token !== generation || request.signal.aborted || !active()) return;
      if ([401, 403, 404].includes(failure.status)) { items = []; nextCursor = null; drafts.clear(); }
      error = failure.status === 403 ? 'You no longer have access to this group.' : 'Activity could not be loaded. Try Refresh.';
    } finally {
      if (token === generation && active()) {
        controller = null; loading = false; render();
        if (needsFocus) {
          const node = (focus && host.querySelector(`#sp-activity-${focus.id}`)) || host.querySelector('#sp-activity-title');
          node?.focus({ preventScroll: true }); node?.scrollIntoView({ block: 'center' }); needsFocus = false;
        }
      }
    }
  }
  function selectThread(id, kind = null, target = null) {
    abortRead(); threadId = id; threadKind = kind; chatOpen = !id; before = null; focus = target; items = [];
    nextCursor = null; postError = ''; needsFocus = true;
    void refresh();
  }
  async function post() {
    if (!active() || posting) return;
    const currentDraft = draft();
    if (!currentDraft.text.trim() || [...currentDraft.text.trim()].length > 500) {
      postError = 'Enter a comment from 1 to 500 characters.'; render(); return;
    }
    const group = groupId;
    const linked = threadId ? { [`${threadKind}Id`]: threadId } : {};
    posting = true; postError = ''; render();
    const request = new AbortController(); postController = request;
    try {
      await apiRequest(`/api/groups/${encodeURIComponent(group)}/comments`, { method: 'POST', signal: request.signal,
        body: { text: currentDraft.text, ...linked, requestKey: currentDraft.requestKey } });
      if (!active() || group !== groupId || postController !== request) return;
      currentDraft.text = ''; currentDraft.requestKey = crypto.randomUUID();
      before = null; focus = null;
      announce('Comment posted.');
      void refresh();
    } catch (failure) {
      if (request.signal.aborted || !active() || group !== groupId) return;
      if ([401, 403].includes(failure.status)) { items = []; drafts.clear(); }
      postError = failure.status === 429 ? failure.message : 'Comment could not be posted. Retry with the same text to avoid duplicates.';
      announce(postError);
    } finally {
      if (postController === request) {
        posting = false; postController = null; render();
        if (active() && root.ownerDocument.activeElement === root.ownerDocument.body) host.querySelector('#sp-comment-text')?.focus({ preventScroll: true });
      }
    }
  }
  root.addEventListener('input', (event) => {
    if (active() && event.target.id === 'sp-comment-text') {
      const current = draft(); current.text = event.target.value; current.requestKey = crypto.randomUUID();
    }
  });
  root.addEventListener('click', (event) => {
    const button = event.target.closest('[data-thread-id], [data-activity-action]');
    if (!active() || !button || (!host.contains(button) && button.dataset.activityAction !== 'chat')) return;
    if (posting) return; // Keep the submitted comment bound to its expense.
    if (button.dataset.threadId) selectThread(button.dataset.threadId, button.dataset.threadKind);
    else if (button.dataset.activityAction === 'chat') selectThread(null);
    else if (['close', 'group'].includes(button.dataset.activityAction)) {
      const thread = threadId;
      abortRead();
      threadId = null; threadKind = null; chatOpen = false; before = null; focus = null;
      render();
      if (thread) [...host.querySelectorAll('[data-thread-id]')].find((button) => button.dataset.threadId === thread)?.focus();
      else root.querySelector('[data-activity-action="chat"]')?.focus();
      void refresh();
    }
    else {
      if (button.dataset.activityAction === 'ledger-older') {
        before = ledgerCursor; focus = null;
        void refresh({ append: true });
        return;
      }
      if (button.dataset.activityAction === 'older') { before = nextCursor; focus = null; needsFocus = true; }
      else if (button.dataset.activityAction === 'latest') { before = null; focus = null; needsFocus = true; }
      void refresh();
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) abortRead(); else if (active()) void refresh();
  });
  root.addEventListener('click', (event) => { if (event.target.closest('#sp-logout')) reset(); });
  window.addEventListener('pagehide', reset);
  return {
    mount(id, target, tab) {
      const nextHost = root.querySelector('#sp-group-activity');
      if (!nextHost || !owned()) { reset(); return; }
      const changed = id !== groupId;
      if (changed) { reset(); groupId = id; }
      host = nextHost;
      selectedTab = tab;
      render();
      if (target?.expenseId || (target?.settlementId && target.commentId)) {
        const point = target.commentId ? { id: target.commentId, type: 'comment' } : null;
        selectThread(target.expenseId || target.settlementId, target.expenseId ? 'expense' : 'settlement', point);
      } else if (target?.settlementId) {
        focus = { id: target.settlementId, type: 'settlement' };
        needsFocus = true;
        void refresh();
      } else if (target?.commentId) {
        selectThread(null, null, { id: target.commentId, type: 'comment' });
      } else if (changed) void refresh();
      else render();
    },
    detach: reset,
    handleForm(form) { if (form.id !== 'sp-comment-form') return false; void post(); return true; },
    onNotifications(notifications) {
      if (!active() || document.hidden) return;
      const relevant = notifications.filter((item) => item.groupId === groupId);
      unread = relevant.filter((item) => item.kind === 'comment_added' && !item.expenseId && !item.settlementId && !item.readAt).length;
      const badge = root.querySelector('#sp-group-unread');
      if (badge) badge.textContent = unread ? `(${unread})` : '';
      const next = relevant.map((item) => item.id).join(',');
      if (next !== fingerprint && !loading && !posting) { fingerprint = next; void refresh(); }
    },
  };
}
