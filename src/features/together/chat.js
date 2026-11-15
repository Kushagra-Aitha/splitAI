import { apiRequest, getSession } from '../../api/session.js';
import { preserveFocus } from '../../lib/focus.js';
import { GUARD_REASONS } from '../../../shared/guard-reasons.js';
import { toneFor } from '../../lib/avatar.js';

const timeText = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' });
const dayText = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
const dayKey = (value) => new Date(value).toDateString();
const byTime = (a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(b.id);

function dayLabel(value) {
  const now = new Date();
  if (dayKey(value) === dayKey(now)) return 'Today';
  now.setDate(now.getDate() - 1);
  return dayKey(value) === dayKey(now) ? 'Yesterday' : dayText.format(new Date(value));
}

export function createGroupChat({ root, esc, money, icon, icons, announce, personAvatar }) {
  let model, host, feed, timer, reading, marking = false;
  let notifications = [];
  const readIds = new Set();
  const active = () => host?.isConnected && !!getSession() && !document.hidden;
  const bottom = () => feed.scrollHeight - feed.scrollTop - feed.clientHeight < 48;

  function badge() {
    const node = root.querySelector('[data-group-chat-unread]');
    if (!node) return;
    const count = unread(node.dataset.groupChatUnread).length;
    node.textContent = count ? ` (${count})` : '';
  }

  function unread(groupId) {
    return notifications.filter((item) => item.groupId === groupId && item.kind === 'comment_added' &&
      !item.expenseId && !item.settlementId && !item.readAt && !readIds.has(item.id));
  }

  async function markVisible() {
    if (!active() || marking || !bottom()) return;
    const ids = unread(model.id).filter((item) => model.entries.has(item.sourceId)).map((item) => item.id);
    if (!ids.length) return;
    marking = true;
    try {
      await apiRequest('/api/notifications/read', { method: 'POST', body: { ids } });
      for (const id of ids) readIds.add(id);
      badge();
    } catch { /* Retry when the feed is next refreshed. */ }
    finally { marking = false; }
  }

  function system(item) {
    const amount = money(item.amountCents);
    if (item.type === 'expense') return `${item.authorName} added ${item.merchant} · ${amount}`;
    if (item.status === 'posted') return `${item.authorName} paid ${item.payeeName} · ${amount}`;
    return `${item.authorName} → ${item.payeeName} · ${amount} · ${item.status === 'failed' ? 'Payment failed' : 'Payment pending'}`;
  }

  // A19 · Messaging layout: yours on the right, everyone else's on the left
  // with their avatar and name on the first message of a run; time inside the
  // bubble; days and money events as centred chips.
  function message(item, previous, firstOnDay) {
    const time = `<time datetime="${esc(item.occurredAt)}">${timeText.format(new Date(item.occurredAt))}</time>`;
    if (item.type !== 'comment') {
      return `<li class="group-chat-system"><span>${icon(item.type === 'expense' ? 'receipt' : 'hand-coins')}${esc(system(item))}${time}</span></li>`;
    }
    const mine = item.authorUserId === getSession()?.actor.userId;
    const first = firstOnDay || previous?.type !== 'comment' || previous.authorUserId !== item.authorUserId;
    const shown = model.revealed.has(item.id);
    const reason = item.guardReasons?.map((code) => GUARD_REASONS[code]).filter(Boolean).join(' ') || 'Guard flagged this message.';
    const body = item.guardFlagged ? `<p class="group-chat-warning">${icon('shield-alert')}${esc(reason)}</p>
      <button class="guard-message ${shown ? '' : 'is-hidden'}" type="button" id="sp-chat-reveal-${esc(item.id)}"
        data-chat-reveal="${esc(item.id)}" aria-expanded="${shown}">
        <span class="guard-message-text"${shown ? '' : ' aria-hidden="true"'}>${esc(item.text)}</span>
        ${shown ? '' : '<span class="guard-message-cover">Tap to show the message</span>'}
      </button>` : `<p class="group-chat-text">${esc(item.text)}</p>`;
    const delivery = item.delivery === 'pending' ? '<span class="group-chat-state">Sending…</span>'
      : item.delivery === 'failed' ? `<span class="group-chat-state is-failed">Not sent</span><button type="button" class="text-button" data-chat-retry="${esc(item.id)}">Retry</button>`
        : mine ? `<span class="group-chat-state is-sent" aria-label="Sent">${icon('check')}</span>` : '';
    const who = { userId: item.authorUserId, displayName: item.authorName };
    return `<li class="group-chat-message ${mine ? 'is-mine' : 'is-theirs'}${first ? ' is-first' : ''}" id="sp-group-message-${esc(item.id)}" tabindex="-1">
      ${mine ? '' : `<span class="group-chat-avatar">${first ? personAvatar(who, { label: false }) : ''}</span>`}
      <div class="group-chat-bubble"${mine ? '' : ` aria-label="${esc(item.authorName)}"`}>
        ${first && !mine ? `<span class="group-chat-author tone-${toneFor(item.authorUserId)}">${esc(item.authorName)}</span>` : ''}
        ${body}<span class="group-chat-meta">${time}${delivery}</span>
      </div>
    </li>`;
  }

  function render({ pin = false, prepend = false, restore } = {}) {
    if (!active()) return;
    const top = feed.scrollTop, height = feed.scrollHeight;
    const items = [...model.entries.values(), ...model.outbox.values()].sort(byTime);
    preserveFocus(feed, () => {
      feed.querySelector('ol').innerHTML = items.map((item, index) => {
        const previous = items[index - 1];
        const newDay = !previous || dayKey(item.occurredAt) !== dayKey(previous.occurredAt);
        return (newDay ? `<li class="group-chat-day"><span>${esc(dayLabel(item.occurredAt))}</span></li>` : '') +
          message(item, previous, newDay);
      }).join('');
    });
    icons();
    const status = host.querySelector('[data-chat-status]');
    status.textContent = model.error || (!model.loaded ? 'Loading messages…' : !items.length ? 'No messages yet.' : '');
    host.querySelector('[data-chat-jump]').hidden = !model.newMessages;
    if (pin) feed.scrollTop = feed.scrollHeight;
    else if (prepend) feed.scrollTop = top + feed.scrollHeight - height;
    else feed.scrollTop = restore ?? top;
    model.scroll = feed.scrollTop;
    model.atBottom = bottom();
    if (model.atBottom) {
      model.newMessages = false;
      host.querySelector('[data-chat-jump]').hidden = true;
      void markVisible();
    }
  }

  function merge(state, items) {
    for (const item of items) {
      state.entries.set(item.id, item);
      if (item.requestKey) state.outbox.delete(item.requestKey);
    }
  }

  async function load({ older = false, focusId } = {}) {
    if (!active() || reading || (older && !model.cursor)) return;
    const current = model, request = new AbortController();
    reading = request;
    const query = new URLSearchParams({ view: 'chat', limit: 50 });
    if (older) query.set('before', current.cursor);
    if (focusId) { query.set('focusId', focusId); query.set('focusType', 'comment'); }
    try {
      const { items, nextCursor } = await apiRequest(`/api/groups/${encodeURIComponent(current.id)}/activity?${query}`,
        { signal: request.signal });
      if (request.signal.aborted || current !== model || !active()) return;
      const wasAtBottom = bottom();
      const newest = [...current.entries.values()].sort(byTime).at(-1);
      if (!older && !focusId && current.loaded && !wasAtBottom && items.some((item) =>
        !current.entries.has(item.id) && (!newest || byTime(item, newest) > 0) && (item.type !== 'comment' || item.authorUserId !== getSession()?.actor.userId))) current.newMessages = true;
      merge(current, items);
      if (!current.loaded || older || focusId) current.cursor = nextCursor;
      const initial = !current.loaded;
      current.loaded = true;
      current.error = '';
      render({ prepend: older, pin: !older && !focusId && (initial || wasAtBottom) });
      if (focusId) {
        const target = root.ownerDocument.getElementById(`sp-group-message-${focusId}`);
        target?.scrollIntoView({ block: 'nearest' });
        target?.focus({ preventScroll: true });
      }
    } catch (error) {
      if (!request.signal.aborted && current === model && active()) {
        if ([401, 403].includes(error.status)) {
          current.entries.clear();
          current.outbox.clear();
        }
        current.error = error.message || 'Couldn’t load messages.';
        render();
      }
    } finally {
      if (reading === request) reading = null;
    }
  }

  async function send(item) {
    const current = model;
    item.delivery = 'pending';
    render({ pin: true });
    try {
      const { comment } = await apiRequest(`/api/groups/${encodeURIComponent(current.id)}/comments`, {
        method: 'POST', body: { text: item.text, requestKey: item.id },
      });
      current.outbox.delete(item.id);
      current.entries.set(comment.id, { ...comment, authorName: item.authorName, type: 'comment', occurredAt: comment.createdAt });
      if (model === current) {
        render({ pin: active() && bottom() });
        if (active()) announce('Message sent.');
      }
    } catch {
      if (current.outbox.has(item.id)) item.delivery = 'failed';
      if (model === current) render();
    }
  }

  function resize(input) {
    input.style.height = 'auto';
    input.style.height = `${input.scrollHeight}px`;
  }

  function viewport() {
    if (!active() || !window.visualViewport) return;
    host.style.setProperty('--chat-viewport', `${window.visualViewport.height}px`);
  }
  document.addEventListener('visibilitychange', () => { if (active()) void load(); });
  window.visualViewport?.addEventListener('resize', viewport);

  function detach() {
    clearInterval(timer);
    reading?.abort();
    reading = null;
    host = null;
    feed = null;
  }

  return {
    mount(id, focusId) {
      const next = root.querySelector('[data-group-chat]');
      if (!next) {
        detach();
        if (model) model.atBottom = true;
        badge();
        return;
      }
      if (next === host && !focusId) return;
      const opening = !host;
      detach();
      if (model?.id !== id) model = { id, entries: new Map(), outbox: new Map(), revealed: new Set(), draft: '', atBottom: true };
      host = next;
      const name = host.dataset.chatName || 'the group';
      host.innerHTML = `<header class="group-chat-head">
          ${personAvatar({ userId: id, displayName: name }, { label: false })}
          <div><strong>${esc(name)}</strong><span>${esc(host.dataset.chatMembers || '')}</span></div>
          <span class="group-chat-guard">${icon('shield-check')}Guard checks messages</span>
        </header>
        <div class="group-chat-feed" tabindex="0" aria-label="Conversation in ${esc(name)}">
        <p data-chat-status role="status"></p><ol></ol></div>
        <form class="group-chat-composer" id="sp-group-chat-form">
          <button type="button" class="group-chat-jump" data-chat-jump hidden>New messages ${icon('chevron-down')}</button>
          <label class="sr-only" for="sp-group-chat-text">Message ${esc(name)}</label>
          <textarea id="sp-group-chat-text" name="text" rows="1" maxlength="500" placeholder="Message ${esc(name)}" required></textarea>
          <button type="submit" class="primary" aria-label="Send message">${icon('arrow-up')}</button>
        </form>`;
      icons();
      feed = host.querySelector('.group-chat-feed');
      const input = host.querySelector('textarea');
      input.value = model.draft;
      resize(input);
      viewport();
      render({ pin: model.atBottom, restore: model.scroll });
      // Opening the tab brings the whole conversation into view, like a chat app.
      if (opening && !focusId) {
        const tabs = root.querySelector('.group-tabs') ?? host;
        const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
        window.scrollTo({ top: tabs.getBoundingClientRect().top + window.scrollY - 8, behavior: reduce ? 'auto' : 'smooth' });
      }
      feed.addEventListener('scroll', () => {
        if (!active()) return;
        model.scroll = feed.scrollTop;
        model.atBottom = bottom();
        if (model.atBottom) {
          model.newMessages = false;
          host.querySelector('[data-chat-jump]').hidden = true;
          void markVisible();
        } else if (feed.scrollTop < 48) void load({ older: true });
      });
      timer = setInterval(load, 3000);
      void (async () => {
        const current = model;
        await load();
        if (focusId && current === model && active()) {
          const target = root.ownerDocument.getElementById(`sp-group-message-${focusId}`);
          if (target) { target.scrollIntoView({ block: 'nearest' }); target.focus({ preventScroll: true }); }
          else await load({ focusId });
        }
      })();
    },
    detach,
    onNotifications(items) {
      notifications = items;
      const known = new Set(items.filter((item) => !item.readAt).map((item) => item.id));
      for (const id of readIds) if (!known.has(id)) readIds.delete(id);
      badge();
      void markVisible();
    },
    handleForm(form, data) {
      if (form.id !== 'sp-group-chat-form' || !active()) return false;
      const text = String(data.get('text') ?? '').trim();
      if (!text || text.length > 500) return true;
      const actor = getSession().actor;
      const item = { id: crypto.randomUUID(), type: 'comment', text, occurredAt: new Date().toISOString(),
        authorUserId: actor.userId, authorName: actor.displayName };
      model.outbox.set(item.id, item);
      model.draft = '';
      form.reset();
      resize(form.elements.text);
      void send(item);
      return true;
    },
    input(event) {
      if (!active() || event.target.id !== 'sp-group-chat-text') return;
      model.draft = event.target.value;
      resize(event.target);
    },
    keydown(event) {
      if (active() && event.target.id === 'sp-group-chat-text' && event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        event.target.form.requestSubmit();
      }
    },
    click(button) {
      if (!active() || !host.contains(button)) return false;
      if (button.hasAttribute('data-chat-jump')) render({ pin: true });
      else if (button.dataset.chatReveal) {
        const id = button.dataset.chatReveal;
        if (model.revealed.has(id)) model.revealed.delete(id); else model.revealed.add(id);
        render();
      } else if (button.dataset.chatRetry) {
        const item = model.outbox.get(button.dataset.chatRetry);
        if (item?.delivery === 'failed') void send(item);
      } else return false;
      return true;
    },
  };
}
