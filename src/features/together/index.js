import { apiRequest } from '../../api/session.js';
import { GROUPS, USERS } from '../../../server/db/demo-ids.js';
import { formatUsdCents, usdToCents } from '../../lib/money.js';

export function createTogether({ root, state, demo, icon, money, esc, heading, avatar, stack, shareFor, render, persist, announce, openModal, closeModal, closeButton, toast, go, tx }) {
  function ticket() {
    const names = demo.draft.people;
    let share = Math.floor(demo.draft.cents / names.length);
    return `<div class="expense-ticket"><div class="ticket-top"><div class="ticket-kicker"><span class="eyebrow">Ready when you are</span><span class="pending-label">Not saved yet</span></div><div class="ticket-amount display money">${money(demo.draft.cents)}</div><h3>${esc(demo.draft.merchant)}</h3><span class="small muted">${esc(demo.draft.category)} · Paid by you</span></div><div class="ticket-middle"><div class="math-line small"><span class="muted">Split equally in</span><strong>Puffton 4</strong></div><div class="split-equation"><div class="split-people">${names.map((n, i) => `<div class="split-person">${avatar(n)}<span>${n === 'Maya' ? 'You' : n}</span><strong class="money">${money(share + (i === 0 ? demo.draft.cents - share * names.length : 0))}</strong></div>`).join('')}</div><button type="button" class="text-button cursor-interaction" data-action="edit-split">Edit</button></div><div class="ticket-actions"><button type="button" class="primary cursor-interaction" data-action="confirm-expense">${icon('check')}Confirm expense</button><button type="button" class="secondary cursor-interaction" data-action="discard">Discard</button></div></div><div class="ticket-foot">${icon('shield-check')}Adds a shared expense. No money will be transferred.</div></div>`;
  }
  let cached;
  const reviews = new Map();
  let groupCreated;

  function registerReview(draft, { onConfirmed, onDiscard } = {}) {
    const existing = reviews.get(draft.id);
    if (!existing?.pending) reviews.set(draft.id, { draft, onConfirmed, onDiscard, pending: false });
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
    return `<button type="button" class="guard-pill" data-go="guard">${icon('shield-check')}Guard is on</button>` + renderGroups();
  }

  function renderGroups() {
    const id = state.group;
    void loadGroup(id);
    if (cached.error) return `<p role="alert">${esc(cached.error)}</p><button data-action="retry-groups">Retry</button>`;
    if (!cached.data) return '<p role="status">Loading groups…</p>';
    if (!id) {
      return heading('Your groups', 'Together', '', '<button class="primary" data-action="new-group">New group</button>') +
        `<div class="group-list">${cached.data.groups.map((g) => `
          <section class="group-large"><h2>${esc(g.name)}</h2><p>${g.memberCount} members</p>
          <p>You owe ${money(g.youOweCents)} · Owed to you ${money(g.owedToYouCents)}</p>
          <button class="secondary" data-group-id="${esc(g.id)}">Open group</button></section>`).join('') || '<p>No groups yet.</p>'}</div>`;
    }
    const { group, members, debts, ledger } = cached.data;
    return '<button class="back-button" data-go="groups">All groups</button>' +
      heading(group.kind === 'trip' ? 'Trip' : 'Roommates', esc(group.name), esc(group.tagline ?? ''),
        '<button class="primary" data-action="new-group-expense">Add expense</button>') +
      `<div class="member-list">${members.map((m) => `<p>${esc(m.displayName)}${m.isYou ? ' (you)' : ''}</p>`).join('')}</div>
        <section><h2>You owe ${money(debts.youOweCents)}</h2>
          ${debts.youOwe.map((d) => `<p>${esc(d.displayName)} · ${money(d.cents)}
            <button type="button" class="secondary" data-settle-with="${esc(d.userId)}">Settle up</button></p>`).join('')}
        <h2>Owed to you ${money(debts.owedToYouCents)}</h2>
          ${debts.owedToYou.map((d) => `<p>${esc(d.displayName)} · ${money(d.cents)}</p>`).join('')}</section>
        <section><h2>Recent shared costs</h2>${ledger.map((entry) => entry.type === 'expense'
          ? tx(esc(entry.merchant), 'Your share', money(entry.yourShareCents), 'receipt')
          : tx('Settlement', esc(entry.status), money(entry.amountCents), 'users')).join('') || '<p>No shared activity yet.</p>'}</section>`;
  }

  function showGroup(id) {
    cached = undefined;
    state.page = 'groups';
    state.group = id;
    render();
  }

  function newGroup({ onCreated } = {}) {
    groupCreated = onCreated;
    openModal('New group', `<h2>New group</h2>${closeButton}
      <form id="sp-group-form" class="field-grid">
      <label class="field">Name<input name="name" required></label>
      <label class="field">Type<select name="kind"><option value="roommates">Roommates</option><option value="trip">Trip</option></select></label>
      <label class="field">Starts on<input name="startsOn" type="date"></label>
      <label class="field">Ends on<input name="endsOn" type="date"></label>
      <fieldset><legend>Demo members</legend>${Object.entries(USERS).map(([name, id]) =>
        `<label><input type="checkbox" name="member" value="${id}"> ${name[0].toUpperCase() + name.slice(1)}</label> `).join('')}</fieldset>
      <button class="primary" type="submit">Create group</button><p role="alert"></p></form>`);
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

  function draftTicket(draft) {
    const pending = reviews.get(draft.id)?.pending ?? false;
    return `<div class="expense-ticket"><h3>${esc(draft.merchant)} · ${formatUsdCents(draft.totalCents)}</h3>
      ${draft.shares.map((s) => `<div class="math-line"><span>${esc(s.displayName)}</span><strong>${formatUsdCents(s.cents)}</strong></div>`).join('')}
      ${draft.status === 'confirmed' ? '<p class="success-stamp">Saved.</p>' : `<form data-expense-confirm data-draft-id="${esc(draft.id)}" aria-label="Confirm shared expense" aria-describedby="sp-expense-error-${esc(draft.id)}" aria-busy="${pending}"><button class="primary" type="submit" ${pending ? 'disabled' : ''}>Confirm expense</button><button class="secondary" type="button" data-action="discard-review" data-draft-id="${esc(draft.id)}" ${pending ? 'disabled' : ''}>Discard</button><p role="status">${pending ? 'Saving expense…' : ''}</p><p id="sp-expense-error-${esc(draft.id)}" role="alert" aria-atomic="true"></p></form>`}
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
    try {
      if (form.id === 'sp-group-form') {
        const onCreated = groupCreated;
        const { group } = await apiRequest('/api/groups', { method: 'POST', body: {
          name: fd.get('name'), kind: fd.get('kind'), startsOn: fd.get('startsOn') || null, endsOn: fd.get('endsOn') || null,
          memberIds: fd.getAll('member'),
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
          ({ expense } = await apiRequest(`/api/expense-drafts/${encodeURIComponent(review.draft.id)}/confirm`, { method: 'POST', body: {} }));
        } finally {
          review.pending = false;
        }
        cached = undefined;
        if (form.isConnected && form.closest('[role="dialog"]')) closeModal();
        reviews.delete(review.draft.id);
        if (review.onConfirmed) await review.onConfirmed(expense);
        else showGroup(review.draft.groupId);
        toast('Expense saved.');
      }
    } catch (error) {
      form.querySelector('[role="alert"]').textContent = error.message;
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

  function editSplit() {
    openModal(
      'Edit expense',
      `<div class="modal-header"><div><div class="eyebrow">Before you confirm</div><h2>Make it your split.</h2></div>${closeButton}</div><form id="sp-edit-form"><label class="field">Merchant<input name="merchant" required maxlength="60" value="${esc(demo.draft.merchant)}"></label><div class="field-grid"><label class="field">Total, USD<input name="amount" type="number" min="0.01" max="9999.99" step="0.01" required value="${(demo.draft.cents / 100).toFixed(2)}"></label><label class="field">Category<select name="category">${['Food & drink', 'Getting around', 'Just for fun', 'Groceries'].map((n) => `<option ${n === demo.draft.category ? 'selected' : ''}>${n}</option>`).join('')}</select></label></div><p style="margin:13px 0 5px">Split equally with members of Puffton 4</p>${['Maya', 'Sam', 'Priya'].map((n) => `<label class="check-label"><input type="checkbox" name="person" value="${n}" ${demo.draft.people.includes(n) ? 'checked' : ''} ${n === 'Maya' ? 'disabled' : ''}>${n === 'Maya' ? 'You · paid the full amount' : n}</label>`).join('')}<div id="sp-edit-error" class="error" role="alert"></div><div class="modal-actions"><button type="button" class="secondary cursor-interaction" data-action="close">Cancel</button><button type="submit" class="primary cursor-interaction">Update preview</button></div><div class="modal-fine">Nothing is saved until you confirm the expense.</div></form>`,
    );
  }
  root.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
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
      case 'edit-split':
        editSplit();
        break;
      case 'confirm-expense':
        if (state.logged) break;
        state.logged = true;
        demo.messages = demo.messages.filter((m) => !m.html?.includes('expense-ticket'));
        demo.draftVisible = false;
        render();
        persist();
        toast('Expense saved. Everyone has the same numbers.');
        break;
      case 'discard':
        demo.draftVisible = false;
        demo.messages = demo.messages.filter((m) => !m.html?.includes('expense-ticket'));
        render();
        toast('Preview discarded. Nothing was saved.');
        break;
    }
  });
  function handleExpenseForm(form, fd) {
    if (form.id === 'sp-settlement-confirm') { void confirmSettlement(form); return; }
    if (['sp-group-form', 'sp-group-expense-form'].includes(form.id) || form.hasAttribute('data-expense-confirm')) {
      void submitGroupForm(form, fd);
      return;
    }
    if (form.id !== 'sp-edit-form') return;
      const amount = Math.round(Number(fd.get('amount')) * 100),
        selected = ['Maya', ...fd.getAll('person').filter((n) => n !== 'Maya')];
      if (
        !fd.get('merchant')?.trim() ||
        amount < 1 ||
        !Number.isFinite(amount) ||
        selected.length < 2
      ) {
        root.querySelector('#sp-edit-error').textContent =
          'Add a merchant, a positive amount, and at least one other person.';
        return;
      }
      demo.draft = {
        ...demo.draft,
        merchant: String(fd.get('merchant')).trim(),
        cents: amount,
        people: selected,
        category: String(fd.get('category')),
      };
      closeModal();
      demo.draftVisible = true;
      demo.messages = demo.messages.filter((m) => !m.html?.includes('expense-ticket'));
      render();
      announce('Expense preview updated. Not saved yet.');
  }

  return { groups, ticket, draftTicket, registerReview, openGroupCreation: newGroup, handleExpenseForm };
}
