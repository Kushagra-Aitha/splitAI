import { apiRequest, getSession } from '../../api/session.js';
import { preserveFocus } from '../../lib/focus.js';

// Activity owns only its section. Refreshes never replace Together's ledger
// state, feed data never enters Ask, and comment drafts stay in memory only.
export function createActivity({ root, state, esc, money, announce }) {
  const actorId = getSession()?.actor.userId;
  let groupId = null, expenseId = null, host = null, items = [], expense = null;
  let before = null, focus = null, nextCursor = null, loading = false, error = '', postError = '';
  let controller, postController, generation = 0, posting = false, needsFocus = false, fingerprint = '';
  const drafts = new Map();
  const owned = () => !!actorId && getSession()?.actor.userId === actorId;
  const active = () => owned() && state.page === 'groups' && state.group === groupId && host?.isConnected;
  const draft = () => {
    const key = expenseId || 'group';
    if (!drafts.has(key)) drafts.set(key, { text: '', requestKey: crypto.randomUUID() });
    return drafts.get(key);
  };
  const date = (value) => `<time class="small muted" datetime="${esc(value)}">${esc(new Date(value).toLocaleString())}</time>`;
  const threadButton = (id, label = 'View expense comments') => `<button type="button" class="text-button" data-expense-thread="${esc(id)}">${label}</button>`;
  function entry(item) {
    let content;
    if (item.type === 'comment') content = `<p class="small"><strong>${esc(item.authorName)}</strong> commented</p>
      <p class="comment-text">${esc(item.text)}</p>${item.expenseId && !expenseId ? threadButton(item.expenseId) : ''}`;
    else if (item.type === 'expense') content = `<h3>${esc(item.merchant)} · ${money(item.amountCents)}</h3>
      <p class="small muted">Paid by ${esc(item.authorName)} · Your share ${money(item.yourShareCents)}</p>${threadButton(item.id, 'Comments on this expense')}`;
    else content = `<h3>Settlement · ${money(item.amountCents)}</h3><p>${esc(item.authorName)} to ${esc(item.payeeName)} · ${esc(item.status)}</p>`;
    return `<li><article id="sp-activity-${esc(item.id)}" data-ledger-entry="${esc(item.id)}" tabindex="-1" class="activity-entry">${content}${date(item.occurredAt)}</article></li>`;
  }
  function render() {
    if (!active()) return;
    preserveFocus(host, () => {
      host.innerHTML = `<div class="activity-heading"><h2 id="sp-activity-title" tabindex="-1">${expenseId ? 'Expense comments' : 'Group activity'}</h2>
        <div>${expenseId ? '<button type="button" class="text-button" data-activity-action="group">All activity</button>' : ''}
        <button type="button" id="sp-activity-refresh" class="text-button" data-activity-action="refresh" ${loading ? 'disabled' : ''}>Refresh</button></div></div>
        ${expense ? `<article data-ledger-entry="${esc(expense.id)}" class="activity-expense"><h3>${esc(expense.merchant)} · ${money(expense.totalCents)}</h3><p>Your share ${money(expense.yourShareCents)}</p>${date(expense.occurredAt)}</article>` : ''}
        ${error ? `<p role="alert">${esc(error)}</p>` : ''}${loading ? '<p role="status">Loading activity…</p>' : ''}
        <ul class="activity-list">${items.map(entry).join('')}</ul>
        ${!items.length && !loading && !error ? `<p>${expenseId ? 'No comments yet.' : 'No shared activity yet.'}</p>` : ''}
        <div class="activity-pages">${before || focus ? '<button type="button" class="text-button" data-activity-action="latest">Latest</button>' : ''}
        ${nextCursor ? `<button type="button" class="text-button" data-activity-action="older" ${loading ? 'disabled' : ''}>Older</button>` : ''}</div>
        <form id="sp-comment-form" class="field-grid">
          <label class="field">${expenseId ? 'Comment on this expense' : 'Comment to the group'}
            <textarea id="sp-comment-text" name="text" rows="3" required aria-describedby="sp-comment-help" ${posting ? 'disabled' : ''}>${esc(draft().text)}</textarea></label>
          <p id="sp-comment-help" class="small muted">Up to 500 characters. Shared with this group's members.</p>
          <button type="submit" class="primary" ${posting ? 'disabled' : ''}>${posting ? 'Posting…' : 'Post comment'}</button>
          <p role="alert">${esc(postError)}</p>
        </form>`;
    });
  }
  function abortRead() { generation++; controller?.abort(); controller = null; loading = false; }
  function reset() {
    abortRead(); postController?.abort(); postController = null;
    groupId = null; expenseId = null; host = null; items = []; expense = null;
    before = null; focus = null; nextCursor = null; error = ''; postError = '';
    drafts.clear(); posting = false; needsFocus = false; fingerprint = '';
  }
  async function refresh() {
    if (!active() || document.hidden) return;
    abortRead();
    const token = generation, request = new AbortController(); controller = request;
    const params = new URLSearchParams();
    if (expenseId) params.set('expenseId', expenseId);
    if (before) params.set('before', before);
    else if (focus) { params.set('focusId', focus.id); params.set('focusType', focus.type); }
    loading = true; error = ''; render();
    try {
      const data = await apiRequest(`/api/groups/${encodeURIComponent(groupId)}/activity?${params}`, { signal: request.signal });
      if (token !== generation || !active()) return;
      items = data.items; expense = data.expense; nextCursor = data.nextCursor;
    } catch (failure) {
      if (token !== generation || request.signal.aborted || !active()) return;
      if ([401, 403, 404].includes(failure.status)) { items = []; expense = null; nextCursor = null; drafts.clear(); }
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
  function selectThread(id, target = null) {
    abortRead(); expenseId = id; before = null; focus = target; items = []; expense = null;
    nextCursor = null; postError = ''; needsFocus = true;
    void refresh();
  }
  async function post() {
    if (!active() || posting) return;
    const currentDraft = draft();
    if (!currentDraft.text.trim() || [...currentDraft.text.trim()].length > 500) {
      postError = 'Enter a comment from 1 to 500 characters.'; render(); return;
    }
    const group = groupId, linkedExpense = expenseId;
    posting = true; postError = ''; render();
    const request = new AbortController(); postController = request;
    try {
      await apiRequest(`/api/groups/${encodeURIComponent(group)}/comments`, { method: 'POST', signal: request.signal,
        body: { text: currentDraft.text, expenseId: linkedExpense, requestKey: currentDraft.requestKey } });
      if (!active() || group !== groupId || postController !== request) return;
      currentDraft.text = ''; currentDraft.requestKey = crypto.randomUUID();
      before = null; focus = null;
      announce('Comment posted.');
      void refresh();
    } catch (failure) {
      if (request.signal.aborted || !active() || group !== groupId) return;
      if ([401, 403].includes(failure.status)) { items = []; expense = null; drafts.clear(); }
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
    const button = event.target.closest('[data-expense-thread], [data-activity-action]');
    if (!active() || !button || !host.contains(button)) return;
    if (posting) return; // Keep the submitted comment bound to its expense.
    if (button.dataset.expenseThread) selectThread(button.dataset.expenseThread);
    else if (button.dataset.activityAction === 'group') selectThread(null);
    else {
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
    mount(id, target) {
      const nextHost = root.querySelector('#sp-group-activity');
      if (!nextHost || !owned()) { reset(); return; }
      const changed = id !== groupId;
      if (changed) { reset(); groupId = id; }
      host = nextHost;
      if (target) {
        const point = target.commentId ? { id: target.commentId, type: 'comment' } :
          target.settlementId ? { id: target.settlementId, type: 'settlement' } : null;
        selectThread(target.expenseId || null, point);
      } else if (changed) void refresh();
      else render();
    },
    detach: reset,
    handleForm(form) { if (form.id !== 'sp-comment-form') return false; void post(); return true; },
    onNotifications(notifications) {
      if (!active() || document.hidden) return;
      const next = notifications.filter((item) => item.groupId === groupId).map((item) => item.id).join(',');
      if (next !== fingerprint && !loading && !posting) { fingerprint = next; void refresh(); }
    },
  };
}
