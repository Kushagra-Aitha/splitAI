import { apiRequest } from '../../api/session.js';
import { GROUPS } from '../../../server/db/demo-ids.js';
import { formatUsdCents, usdToCents } from '../../lib/money.js';
import { createActivity } from './activity.js';

const groupTypes = { trip: 'Trip', roommates: 'Roommates', friends: 'Friends', couple: 'Couple', event: 'Event', work: 'Work' };
const photos = import.meta.glob('./photos/*.webp', { eager: true, import: 'default' });
const bannerUrl = (kind) => photos[`./photos/${kind}.webp`] ?? photos['./photos/roommates.webp'];
const groupTabs = ['Activity', 'Balances', 'Recurring'];

export function createTogether({ root, state, demo, icon, money, esc, heading, avatar, stack, shareFor, render, persist, announce, openModal, closeModal, closeButton, toast, go, tx }) {
  const activity = createActivity({ root, state, esc, money, announce });
  const avatars = (initials) => `<span class="avatar-stack" aria-hidden="true">${initials.slice(0, 5)
    .map((value) => `<span class="avatar">${esc(value)}</span>`).join('')}</span>`;
  let cached;
  let tab = "Activity";
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

  function balanceLabel(group) {
    if (!group.youOweCents && !group.owedToYouCents) return '<strong>All square</strong>';
    return [group.youOweCents ? `<strong class="group-owe">You owe ${money(group.youOweCents)}</strong>` : '',
      group.owedToYouCents ? `<strong class="group-credit">Owed to you ${money(group.owedToYouCents)}</strong>` : ''].filter(Boolean).join('');
  }

  function groupContext(group) {
    if (group.paymentPending) return 'Payment pending';
    if (group.lastExpense) {
      const elapsed = Date.now() - new Date(group.lastExpense.at).getTime();
      const hours = Math.max(0, Math.floor(elapsed / 3_600_000));
      const when = hours === 0 ? 'just now' : hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
      return `${group.lastExpense.author} added ${group.lastExpense.merchant} · ${when}`;
    }
    return group.tagline || (group.startsOn ? `Starts ${new Date(group.startsOn + 'T12:00:00').toLocaleDateString()}` : 'No expenses yet');
  }

  function renderGroups() {
    const id = state.group;
    void loadGroup(id);
    if (cached.error) return `<p role="alert">${esc(cached.error)}</p><button data-action="retry-groups">Retry</button>`;
    if (!cached.data) return '<p role="status">Loading groups…</p>';
    if (!id) {
      return heading('Your groups', 'Together', '', '<button type="button" class="primary" data-action="new-group">New group</button>') +
        `<div class="groups-grid">${cached.data.groups.map((group) => `
          <article class="sp-card group-tile">
            <button type="button" data-group-id="${esc(group.id)}" aria-label="Open ${esc(group.name)}">
              <img class="group-tile-photo" src="${esc(bannerUrl(group.banner))}" alt="" width="960" height="360">
              <span class="group-tile-body">
                <span class="group-type">${esc(groupTypes[group.kind])}</span>
                <span class="group-tile-name">${esc(group.name)}</span>
                <span class="group-tile-balances">${balanceLabel(group)}</span>
                <span class="group-tile-context small muted" title="${esc(groupContext(group))}">${esc(groupContext(group))}</span>
                <span class="group-tile-members">${avatars(group.memberInitials ?? [])}<span class="small">${group.memberCount} ${group.memberCount === 1 ? 'member' : 'members'}</span></span>
              </span>
            </button>
          </article>`).join('') || '<p>No groups yet.</p>'}</div>`;
    }
    const { group, members, debts, ledger } = cached.data;
    const me = members.find((member) => member.isYou)?.userId;
    const pending = new Set(ledger.filter((item) => item.type === 'settlement' && item.status === 'pending' && item.payerUserId === me)
      .map((item) => item.payeeUserId));
    const payable = debts.youOwe.filter((debt) => !pending.has(debt.userId));
    const balanceRows = [...debts.youOwe, ...debts.owedToYou].map((debt) => {
      const owes = debts.youOwe.includes(debt);
      return `<li><strong>${esc(debt.displayName)}</strong><span>${owes ? 'You owe' : 'Owes you'} ${money(debt.cents)}
        ${owes && pending.has(debt.userId) ? ' · Payment pending' : ''}</span></li>`;
    }).join('');
    return `<div class="group-detail">
      <button type="button" class="back-button" data-go="groups">All groups</button>
      <header class="group-hero">
        <img src="${esc(bannerUrl(group.banner))}" alt="" width="960" height="360">
        <div class="group-hero-copy"><div class="group-type">${esc(groupTypes[group.kind])}</div>
          <h1 tabindex="-1">${esc(group.name)}</h1>${group.tagline ? `<p>${esc(group.tagline)}</p>` : ''}</div>
      </header>
      <div class="group-actions" aria-label="Group actions">
        <details class="group-menu"><summary class="primary">Add expense ▾</summary><div>
          <button type="button" data-group-bank-expense>From a bank transaction</button>
          <button type="button" data-action="new-group-expense">Cash expense</button>
        </div></details>
        <button type="button" class="secondary" data-action="choose-settlement" ${payable.length ? '' : 'disabled'}>Settle up</button>
        <button type="button" class="secondary" data-activity-action="chat">${icon('chat-circle')} Chat <span id="sp-group-unread"></span></button>
        <details class="group-menu"><summary class="secondary" aria-label="More group actions">⋯</summary><div>
          <button type="button" data-action="edit-group">Edit group</button>
          <button type="button" data-action="add-group-member">Add member</button>
          <button type="button" data-action="leave-group">Leave group</button>
          ${group.tagline?.trim() ? `<button type="button" data-ask-note-group="${esc(group.id)}">Check note with Guard</button>` : ''}
        </div></details>
      </div>
      <section class="sp-card group-balance-card" aria-label="Group balance">
        <div><h2>Group balance</h2><div class="group-tile-balances">${balanceLabel(debts)}</div></div>
        <div class="group-tile-members">${avatars(members.map((member) => member.initials))}<span class="small">${members.length} ${members.length === 1 ? 'member' : 'members'}</span></div>
      </section>
      <div class="group-tabs" role="tablist" aria-label="Group sections">
        ${groupTabs.map((label) => `<button type="button" role="tab" id="sp-group-tab-${label}" data-group-tab="${label}" aria-controls="sp-group-panel-${label}" aria-selected="${tab === label}" tabindex="${tab === label ? 0 : -1}">${label}</button>`).join('')}
      </div>
      <div id="sp-group-activity"></div>
      <section id="sp-group-panel-Balances" role="tabpanel" aria-labelledby="sp-group-tab-Balances" ${tab === 'Balances' ? '' : 'hidden'}>
        ${balanceRows ? `<ul class="sp-card group-balance-list">${balanceRows}</ul>` : '<p>All square with this group.</p>'}
        <section class="sp-card group-members"><h2>Members</h2><ul>${members.map((member) => `<li>${esc(member.displayName)}${member.isYou ? ' (you)' : ''}</li>`).join('')}</ul></section>
      </section>
      <section id="sp-group-panel-Recurring" role="tabpanel" aria-labelledby="sp-group-tab-Recurring" ${tab === 'Recurring' ? '' : 'hidden'}>
        ${tab === 'Recurring' ? `<div class="sp-card"><button type="button" class="secondary" data-recurring-action="create" data-group="${esc(group.id)}">Add recurring split</button>
        <section data-recurring-host="${esc(group.id)}" aria-label="Recurring splits"></section></div>` : ''}
      </section>
    </div>`;
  }

  function chooseSettlement() {
    const { debts, ledger, members } = cached.data;
    const me = members.find((member) => member.isYou)?.userId;
    const pending = new Set(ledger.filter((item) => item.type === 'settlement' && item.status === 'pending' && item.payerUserId === me)
      .map((item) => item.payeeUserId));
    openModal('Settle up', `<h2>Settle up</h2>${closeButton}
      <ul class="group-balance-list">${debts.youOwe.filter((debt) => !pending.has(debt.userId)).map((debt) => `
        <li><span>${esc(debt.displayName)}</span><button type="button" class="secondary" data-settle-with="${esc(debt.userId)}">Review ${money(debt.cents)}</button></li>`).join('')}</ul>`);
  }

  function showGroup(id, target = {}) {
    const fromView = root.querySelector('#sp-view').contains(root.ownerDocument.activeElement);
    if (state.group !== id || target.focus) tab = 'Activity';
    cached = undefined;
    navigationTarget = target.focus || fromView ? { ...target, groupId: id } : null;
    state.page = 'groups';
    state.group = id;
    render();
    if (fromView) root.querySelector('#sp-view h1')?.focus({ preventScroll: true });
  }

  function groupForm({ group, onCreated } = {}) {
    groupCreated = onCreated;
    memberEmails = [];
    const title = group ? 'Edit group' : 'New group';
    const options = Object.entries(groupTypes).map(([value, label]) =>
      `<option value="${value}" ${value === (group?.kind ?? 'roommates') ? 'selected' : ''}>${label}</option>`).join('');
    openModal(title, `<h2>${title}</h2>${closeButton}
      <form id="sp-group-form" class="field-grid" data-edit-id="${esc(group?.id ?? '')}">
      <label class="field">Name<input name="name" maxlength="100" value="${esc(group?.name ?? '')}" required></label>
      <label class="field">Type<select name="kind">${options}</select></label>
      <label class="field">Description<input name="tagline" maxlength="200" value="${esc(group?.tagline ?? '')}"></label>
      <fieldset class="group-banner-picker"><legend>Banner photo</legend>
        ${Object.entries(groupTypes).map(([key, label]) => `<label><input type="radio" name="banner" value="${key}" ${key === (group?.banner ?? 'roommates') ? 'checked' : ''}>
          <img src="${esc(bannerUrl(key))}" alt="" width="960" height="360"><span>${label}</span></label>`).join('')}
      </fieldset>
      <label class="field">Starts on<input name="startsOn" type="date" value="${esc(group?.startsOn ?? '')}"></label>
      <label class="field">Ends on<input name="endsOn" type="date" value="${esc(group?.endsOn ?? '')}"></label>
      ${group ? '' : `<label class="field">Member email (optional)<input type="email" name="emails" placeholder="sam@example.com"></label>
      <button type="button" class="secondary" data-action="add-email-chip">Add email</button><div data-email-chips></div>`}
      <button class="primary" type="submit">${group ? 'Save group' : 'Create group'}</button><p role="alert"></p></form>`);
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
        const editId = form.dataset.editId;
        const body = { name: fd.get('name'), kind: fd.get('kind'), banner: fd.get('banner'), tagline: fd.get('tagline'),
          startsOn: fd.get('startsOn') || null, endsOn: fd.get('endsOn') || null };
        if (!editId) body.memberEmails = [...memberEmails, String(fd.get('emails') ?? '').trim()].filter(Boolean);
        const { group } = await apiRequest(editId ? `/api/groups/${encodeURIComponent(editId)}/update` : '/api/groups',
          { method: 'POST', body });
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

  async function reviewSettlement(button) {
    const groupId = state.group;
    const payeeUserId = button.dataset.settleWith;
    const payee = cached.data.members.find((member) => member.userId === payeeUserId);
    button.disabled = true;
    try {
      const { review } = await apiRequest('/api/settlement-reviews', { method: 'POST', body: { groupId, payeeUserId } });
      if (!button.isConnected) return;
      if (button.closest('[role="dialog"]')) closeModal();
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

  const selectTab = (label) => {
    tab = label;
    render();
    root.querySelector(`#sp-group-tab-${label}`)?.focus();
  };

  root.addEventListener('keydown', (event) => {
    if (!event.target.dataset.groupTab) return;
    const index = groupTabs.indexOf(event.target.dataset.groupTab);
    const next = { ArrowLeft: (index + 2) % 3, ArrowRight: (index + 1) % 3, Home: 0, End: 2 }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    selectTab(groupTabs[next]);
  });

  root.addEventListener('change', ({ target }) => {
    if (target.name === 'kind' && target.form?.id === 'sp-group-form' && !target.form.dataset.bannerChosen) {
      target.form.elements.banner.value = target.value;
    }
    if (target.name === 'banner' && target.form?.id === 'sp-group-form') target.form.dataset.bannerChosen = 'true';
  });

  root.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    b.closest('details.group-menu')?.removeAttribute('open');
    if (b.dataset.groupTab) { selectTab(b.dataset.groupTab); return; }
    if (b.hasAttribute('data-group-bank-expense')) {
      state.transactionGroupId = state.group;
      go('transactions');
      return;
    }
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
        groupForm();
        break;
      case 'edit-group':
        groupForm({ group: cached.data.group });
        break;
      case 'choose-settlement':
        chooseSettlement();
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

  return { groups, draftTicket, registerReview, openGroup: showGroup, openGroupCreation: groupForm, handleExpenseForm,
    onNotifications: activity.onNotifications,
    afterRender() {
      if (state.page === 'groups' && state.group && cached?.data && !cached.error) {
        activity.mount(state.group, navigationTarget, tab);
        navigationTarget = null;
      } else activity.detach();
    },
  };
}
