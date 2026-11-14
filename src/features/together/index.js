import { apiRequest } from '../../api/session.js';
import { GROUPS } from '../../../server/db/demo-ids.js';
import { formatUsdCents, usdToCents } from '../../lib/money.js';
import { createActivity } from './activity.js';

export function createTogether({ root, state, demo, icon, money, esc, heading, avatar, stack, shareFor, render, persist, announce, openModal, closeModal, closeButton, toast, go, tx }) {
  const activity = createActivity({ root, state, esc, money, announce });
  const avatars = (initials) => `<span class="avatar-stack" aria-hidden="true">${initials.slice(0, 5)
    .map((value) => `<span class="avatar">${esc(value)}</span>`).join('')}</span>`;
  let cached;
  const reviews = new Map();
  let groupCreated;
  let memberEmails = [];

  function saveEmail(input) {
    if (!input.value.trim() || !input.checkValidity()) return false;
    const email = input.value.trim().toLowerCase();
    if (!memberEmails.includes(email)) memberEmails.push(email);
    input.value = '';
    renderEmailChips(input.form);
    return true;
  }

  function renderEmailChips(form) {
    form.querySelector('[data-email-chips]').innerHTML = memberEmails
      .map((email, i) => `<button type="button" class="tag" data-remove-email="${i}" aria-label="Remove ${esc(email)}">${esc(email)} ×</button>`).join(' ');
  }
  let navigationTarget;

  function registerReview(draft, { onConfirmed, onDiscard, additionalDrafts = [], discardLabel = 'Discard' } = {}) {
    const existing = reviews.get(draft.id);
    if (!existing?.pending) reviews.set(draft.id, { draft, onConfirmed, onDiscard, additionalDrafts, discardLabel, pending: false });
  }

  async function loadGroup(id) {
    if (cached?.id === id) return;
    const pending = { id };
    cached = pending;
    try {
      pending.data = await apiRequest(id ? `/api/groups/${encodeURIComponent(id)}` : '/api/groups');
    } catch (error) {
      pending.error = error.message;
    }
    if (cached === pending && state.page === 'groups' && state.group === id) render();
  }

  function groups() {
    return renderGroups();
  }

  function renderGroups() {
    const id = state.group;
    void loadGroup(id);
    if (cached.error) return `<p role="alert">${esc(cached.error)}</p><button data-action="retry-groups">Retry</button>`;
    if (!cached.data) return '<p role="status">Loading groups…</p>';
    if (!id) {
      return heading('Your groups', 'Together', '', '<button class="primary" data-action="new-group">New group</button>') +
        `<div class="a12-grid">${cached.data.groups.map((g) => {
          const net = g.owedToYouCents - g.youOweCents;
          return `<article class="sp-card a12-group-card"><header><span class="group-picture">${icon(g.kind === 'trip' ? 'luggage' : 'house')}</span>
            <div><h2>${esc(g.name)}</h2><p class="small muted">${g.memberCount} members</p></div></header>
            ${avatars(g.memberInitials ?? [])}
            <p class="${net < 0 ? 'a12-owe' : net > 0 ? 'a12-credit' : ''}">${net < 0 ? 'You owe' : net > 0 ? 'Owed to you' : 'All square'} ${net ? money(Math.abs(net)) : ''}</p>
            <p class="small muted">Last activity ${esc(new Date(g.lastActivityAt).toLocaleDateString())}</p>
            ${g.paymentPending ? '<span class="tag">Payment pending</span>' : ''}
            <button type="button" class="secondary" data-group-id="${esc(g.id)}">Open group</button></article>`;
        }).join('') || '<p>No groups yet.</p>'}</div>`;
    }
    const { group, members, debts, ledger } = cached.data;
    const pending = new Map(ledger.filter((item) => item.type === 'settlement' && item.status === 'pending')
      .map((item) => [`${item.payerUserId}:${item.payeeUserId}`, item.amountCents]));
    const me = members.find((member) => member.isYou)?.userId;
    return '<button class="back-button" data-go="groups">All groups</button>' +
      heading(group.kind === 'trip' ? 'Trip' : 'Roommates', esc(group.name), esc(group.tagline ?? ''),
        '<button type="button" class="primary" data-page="transactions">Split a transaction</button> ' +
        '<button type="button" class="secondary" data-activity-action="chat">Chat <span id="sp-group-unread"></span></button> ' +
        '<details class="a12-menu"><summary aria-label="Group actions">⋯</summary><div>' +
        '<button type="button" data-action="new-group-expense">Add cash expense</button>' +
        `<button type="button" data-recurring-action="create" data-group="${esc(group.id)}">Add recurring split</button>` +
        '<button type="button" data-action="add-group-member">Add member</button>' +
        '<button type="button" data-action="leave-group">Leave group</button></div></details>') +
      avatars(members.map((m) => m.initials)) +
      (group.tagline?.trim() ? `<button type="button" class="text-button" data-ask-note-group="${esc(group.id)}">Check note with Guard</button>` : '') +
      `<div class="a12-layout"><main><section class="sp-card a12-balance"><h2>Group balance</h2>
        ${debts.youOwe.map((d) => `<p>You owe <strong>${esc(d.displayName)} ${money(d.cents)}</strong>
          ${pending.has(`${me}:${d.userId}`) ? `<span class="tag">Payment pending · ${money(pending.get(`${me}:${d.userId}`))}</span>` :
            `<button type="button" class="secondary" data-settle-with="${esc(d.userId)}">Settle up</button>`}</p>`).join('') || '<p>You have nothing to pay.</p>'}
        <p>Owed to you <strong>${money(debts.owedToYouCents)}</strong></p></section>
        <section id="sp-group-activity" aria-label="Group ledger"></section></main>
        <aside class="sp-card member-list"><h2>Members</h2>${members.map((m) => {
          const owes = debts.youOwe.find((d) => d.userId === m.userId);
          const owed = debts.owedToYou.find((d) => d.userId === m.userId);
          return `<p><strong>${esc(m.displayName)}${m.isYou ? ' (you)' : ''}</strong><br>
            <span class="small muted">${owes ? `You pay ${money(owes.cents)}` : owed ? `Pays you ${money(owed.cents)}` : m.isYou ? 'Your group account' : 'All square with you'}</span></p>`;
        }).join('')}<section data-recurring-host="${esc(group.id)}" aria-label="Recurring splits"></section></aside></div>`;
  }

  function showGroup(id, target = {}) {
    const fromView = root.querySelector('#sp-view').contains(root.ownerDocument.activeElement);
    cached = undefined;
    navigationTarget = target.focus || fromView ? { ...target, groupId: id } : null;
    state.page = 'groups';
    state.group = id;
    render();
    if (fromView) root.querySelector('#sp-view h1')?.focus({ preventScroll: true });
  }

  function newGroup({ onCreated } = {}) {
    groupCreated = onCreated;
    memberEmails = [];
    openModal('New group', `<h2>New group</h2>${closeButton}
      <form id="sp-group-form" class="field-grid">
      <label class="field">Name<input name="name" required></label>
      <label class="field">Type<select name="kind"><option value="roommates">Roommates</option><option value="trip">Trip</option></select></label>
      <label class="field">Starts on<input name="startsOn" type="date"></label>
      <label class="field">Ends on<input name="endsOn" type="date"></label>
      <label class="field">Member email (optional)<input type="email" name="emails" placeholder="sam@example.com"></label>
      <button type="button" class="secondary" data-action="add-email-chip">Add email</button><div data-email-chips></div>
      <button class="primary" type="submit">Create group</button><p role="alert"></p></form>`);
  }

  function manageMembership(leave) {
    const title = leave ? 'Leave group' : 'Add member';
    openModal(title, `<h2>${title}</h2>${closeButton}
      <form id="sp-group-membership-form" data-group-id="${esc(state.group)}" data-leave="${leave}">
        ${leave ? '<p>Leave this group? Your past expenses stay in its ledger.</p>' :
          '<label class="field">Member email<input type="email" name="email" required></label>'}
        <button class="primary" type="submit">${title}</button><p role="alert"></p>
      </form>`);
  }

  async function submitMembership(form, fd) {
    const button = form.querySelector('[type="submit"]');
    if (button.disabled) return;
    button.disabled = true;
    const id = form.dataset.groupId;
    const leave = form.dataset.leave === 'true';
    try {
      await apiRequest(`/api/groups/${encodeURIComponent(id)}/${leave ? 'leave' : 'members'}`, {
        method: 'POST', body: leave ? {} : { email: fd.get('email') },
      });
      if (form.isConnected) {
        closeModal();
        showGroup(leave ? null : id);
      } else {
        cached = undefined;
        if (state.page === 'groups') render();
      }
    } catch (error) {
      if (form.isConnected) form.querySelector('[role="alert"]').textContent = error.message;
    } finally {
      button.disabled = false;
    }
  }

  function newExpense() {
    const { members } = cached.data;
    openModal('Add shared expense', `<h2>Add shared expense</h2>${closeButton}
      <form id="sp-group-expense-form" class="field-grid">
      <label class="field">Merchant<input name="merchant" required></label>
      <label class="field">Total, USD<input name="amount" type="number" step="0.01" min="0.01" required></label>
      <fieldset><legend>Split with</legend>${members.map((m) => `<label><input type="checkbox" name="participant" value="${esc(m.userId)}" checked> ${esc(m.displayName)}</label> `).join('')}</fieldset>
      <button class="primary" type="submit">Review split</button><p role="alert"></p></form>`);
  }

  function draftTicket(draft, additionalDrafts = []) {
    const review = reviews.get(draft.id);
    const pending = review?.pending ?? false;
    const items = [draft, ...additionalDrafts].map((item) => `<section><h3>${esc(item.merchant)} · ${formatUsdCents(item.totalCents)}</h3>
      ${item.shares.map((share) => `<div class="math-line"><span>${esc(share.displayName)}</span><strong>${formatUsdCents(share.cents)}</strong></div>`).join('')}</section>`).join('');
    return `<div class="expense-ticket">${items}
      ${draft.status === 'confirmed' ? '<p class="success-stamp">Saved.</p>' : `<form data-expense-confirm data-draft-id="${esc(draft.id)}" aria-label="Confirm shared expense" aria-describedby="sp-expense-error-${esc(draft.id)}" aria-busy="${pending}"><button id="sp-expense-confirm-${esc(draft.id)}" class="primary" type="submit" ${pending ? 'disabled' : ''}>Confirm ${additionalDrafts.length ? 'expenses' : 'expense'}</button><button id="sp-expense-discard-${esc(draft.id)}" class="secondary" type="button" data-action="discard-review" data-draft-id="${esc(draft.id)}" ${pending ? 'disabled' : ''}>${esc(review?.discardLabel ?? 'Discard')}</button><p role="status">${pending ? 'Saving expense…' : ''}</p><p id="sp-expense-error-${esc(draft.id)}" role="alert" aria-atomic="true"></p></form>`}
      <p class="small muted">Adds a shared expense. No money will be transferred.</p></div>`;
  }

  async function submitGroupForm(form, fd) {
    const button = form.querySelector('[type="submit"]');
    if (button.disabled) return;
    button.disabled = true;
    form.setAttribute('aria-busy', 'true');
    const discard = form.querySelector('[data-action="discard-review"]');
    const status = form.querySelector('[role="status"]');
    if (discard) discard.disabled = true;
    if (status) status.textContent = 'Saving expense…';
    if (form.hasAttribute('data-expense-confirm')) announce('Saving expense.');
    try {
      if (form.id === 'sp-group-form') {
        const onCreated = groupCreated;
        const { group } = await apiRequest('/api/groups', { method: 'POST', body: {
          name: fd.get('name'), kind: fd.get('kind'), startsOn: fd.get('startsOn') || null, endsOn: fd.get('endsOn') || null,
          memberEmails: [...memberEmails, String(fd.get('emails') ?? '').trim()].filter(Boolean),
        } });
        if (form.isConnected) closeModal();
        if (onCreated) await onCreated(group);
        else showGroup(group.id);
      } else if (form.id === 'sp-group-expense-form') {
        const { draft } = await apiRequest('/api/expense-drafts', { method: 'POST', body: {
          groupId: state.group, merchant: fd.get('merchant'), cents: usdToCents(String(fd.get('amount')).trim()),
          participantIds: fd.getAll('participant'),
        } });
        if (!form.isConnected) return;
        registerReview(draft);
        openModal('Review split', `<h2>Review split</h2>${closeButton}${draftTicket(draft)}`);
      } else {
        const review = reviews.get(form.dataset.draftId);
        if (!review) throw new Error('Open this expense review again before confirming.');
        if (review.pending) return;
        review.pending = true;
        let expense;
        try {
          const draftIds = [review.draft.id, ...review.additionalDrafts.map(({ id }) => id)];
          const result = await apiRequest(`/api/expense-drafts/${encodeURIComponent(review.draft.id)}/confirm`, {
            method: 'POST', body: draftIds.length > 1 ? { draftIds } : {},
          });
          expense = result.expense ?? result.expenses[0];
        } finally {
          review.pending = false;
        }
        cached = undefined;
        if (form.isConnected && form.closest('[role="dialog"]')) closeModal();
        reviews.delete(review.draft.id);
        if (review.onConfirmed) await review.onConfirmed(expense);
        else showGroup(review.draft.groupId);
        toast(review.additionalDrafts.length ? 'Expenses saved.' : 'Expense saved.');
      }
    } catch (error) {
      const alert = form.querySelector('[role="alert"]');
      alert.textContent = error.message;
      if (form.isConnected && root.ownerDocument.activeElement === root.ownerDocument.body) {
        alert.setAttribute('tabindex', '-1');
        alert.focus({ preventScroll: true });
      }
      announce(error.message);
    } finally {
      button.disabled = false;
      if (discard) discard.disabled = false;
      if (status) status.textContent = '';
      form.setAttribute('aria-busy', 'false');
    }
  }

  async function reviewSettlement(button, { groupId = state.group, payeeUserId = button.dataset.settleWith } = {}) {
    button.disabled = true;
    try {
      const data = cached?.id === groupId && cached.data ? cached.data : await apiRequest(`/api/groups/${encodeURIComponent(groupId)}`);
      const payee = data.members.find((member) => member.userId === payeeUserId);
      if (!payee) throw new Error('This person is no longer available in the group.');
      const { review } = await apiRequest('/api/settlement-reviews', { method: 'POST', body: { groupId, payeeUserId } });
      if (!button.isConnected) return;
      openModal('Review sandbox settlement', `<h2>Review sandbox settlement</h2>${closeButton}
        <p>Pay ${esc(payee.displayName)} <strong>${money(review.amountCents)}</strong> in the Nessie sandbox.</p>
        <form id="sp-settlement-confirm" data-review-id="${esc(review.id)}">
          <button class="primary" type="submit">Approve ${money(review.amountCents)}</button>
          <p role="alert"></p>
        </form>`);
    } catch (error) {
      if (button.isConnected) toast(error.message);
    } finally {
      button.disabled = false;
    }
  }

  async function confirmSettlement(form) {
    const button = form.querySelector('button');
    if (button.disabled) return;
    button.disabled = true;
    try {
      const { settlement } = await apiRequest(
        `/api/settlement-reviews/${encodeURIComponent(form.dataset.reviewId)}/confirm`,
        { method: 'POST', body: {} },
      );
      if (form.isConnected) {
        closeModal();
        toast(settlement.status === 'failed' ? 'Nessie rejected the settlement.' :
          settlement.status === 'posted' ? 'Settlement posted.' : 'Settlement pending verification.');
      }
      cached = undefined;
      if (state.page === 'groups') render();
    } catch (error) {
      if (form.isConnected) form.querySelector('[role="alert"]').textContent = error.message;
    } finally {
      button.disabled = false;
    }
  }

  root.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.hasAttribute('data-remove-email')) {
      memberEmails.splice(Number(b.dataset.removeEmail), 1);
      const form = b.closest('form');
      renderEmailChips(form);
      form.elements.emails.focus();
      return;
    }
    if (b.dataset.settleWith) { void reviewSettlement(b); return; }
    if (b.dataset.groupId) { showGroup(b.dataset.groupId); return; }
    if (b.dataset.filter) {
      state.filter = b.dataset.filter;
      render();
      persist();
      return;
    }
    switch (b.dataset.action) {
      case 'puffton':
        showGroup(GROUPS.puffton4);
        break;
      case 'boston':
        showGroup(GROUPS.bostonWeekend);
        break;
      case 'retry-groups':
        showGroup(state.group);
        break;
      case 'add-group-member':
        manageMembership(false);
        break;
      case 'leave-group':
        manageMembership(true);
        break;
      case 'add-email-chip': {
        const input = b.closest('form').elements.emails;
        if (input.reportValidity()) saveEmail(input);
        input.focus();
        break;
      }
      case 'new-group':
        newGroup();
        break;
      case 'discard-review': {
        const review = reviews.get(b.dataset.draftId);
        if (!review || review.pending) break;
        reviews.delete(b.dataset.draftId);
        if (b.closest('[role="dialog"]')) closeModal();
        review.onDiscard?.();
        break;
      }
      case 'new-group-expense':
        newExpense();
        break;

    }
  });
  function handleExpenseForm(form, fd) {
    if (activity.handleForm(form)) return;
    if (form.id === 'sp-group-membership-form') { void submitMembership(form, fd); return; }
    if (form.id === 'sp-settlement-confirm') { void confirmSettlement(form); return; }
    if (['sp-group-form', 'sp-group-expense-form'].includes(form.id) || form.hasAttribute('data-expense-confirm')) {
      void submitGroupForm(form, fd);
      return;
    }

  }

  return { groups, draftTicket, registerReview, openGroup: showGroup, openGroupCreation: newGroup, handleExpenseForm,
    openSettlement: reviewSettlement,
    onNotifications: activity.onNotifications,
    afterRender() {
      if (state.page === 'groups' && state.group && cached?.data && !cached.error) {
        activity.mount(state.group, navigationTarget);
        navigationTarget = null;
      } else activity.detach();
    },
  };
}
