import { apiRequest } from '../../api/session.js';
import { usdToCents, centsToUsdText, formatUsdCents } from '../../lib/money.js';
import { financialRevision, subscribeFinancialChanges } from '../../api/financial-state.js';

export function createAsk({ root, state, icon, esc, heading, render, announce, go,
  draftTicket, registerReview, openGroupCreation }) {
  const entries = [];
  let composerText = '';
  let sending = false;
  let nextId = 0;
  const label = '<div class="agent-label"><span class="agent-mark">s.</span>Split<span class="tag">AI assistant</span></div>';
  const refresh = () => { if (state.page === 'chat') render(); };

  function selectionCard(entry) {
    const data = entry.response;
    const values = entry.values || {};
    const merchant = values.merchant ?? data.extraction.merchant ?? '';
    const amount = values.amount ?? (data.extraction.cents === null ? '' : centsToUsdText(data.extraction.cents));
    const names = data.unresolvedNames.length ? `<p>Choose the correct group members for: ${esc(data.unresolvedNames.join(', '))}.</p>` : '';
    return `<section class="ask-selection" aria-label="Choose expense details"><p>Choose the group and people, then review the split.</p>${names}
      <form data-ask-selection="${entry.id}"><fieldset ${entry.pending ? 'disabled' : ''}>
      <label class="field">Group<select name="groupId" data-ask-group="${entry.id}" required><option value="">Choose a group</option>
      ${data.groups.map((group) => `<option value="${esc(group.id)}" ${group.id === data.groupId ? 'selected' : ''}>${esc(group.name)}</option>`).join('')}</select></label>
      <div class="field-grid"><label class="field">Merchant<input name="merchant" value="${esc(merchant)}" maxlength="60" required></label>
      <label class="field">Total, USD<input name="amount" inputmode="decimal" value="${esc(amount)}" required></label></div>
      ${data.members.length ? `<fieldset><legend>Split with</legend>${data.members.map((member) => `<label class="check-label"><input type="checkbox" name="participant" value="${esc(member.userId)}" ${data.suggestedParticipantIds.includes(member.userId) ? 'checked' : ''} ${member.isYou ? 'disabled' : ''}>${esc(member.fullName || member.displayName)}${member.handle ? ` (@${esc(member.handle)})` : ''}${member.isYou ? ' · You, the payer' : ''}</label>`).join('')}</fieldset>` : ''}
      <div class="ask-selection-actions"><button type="submit" class="primary" ${!data.groupId ? 'disabled' : ''}>Review split</button>
      <button type="button" class="secondary" data-ask-action="create-group" data-entry-id="${entry.id}">Create a group</button></div></fieldset></form></section>`;
  }

  function entryHtml(entry) {
    let content = '';
    if (entry.response?.type === 'selection_needed') content = selectionCard(entry);
    else if (entry.response?.type === 'blocked') content = `<section class="ask-blocked" role="status" aria-label="Guard blocked this request"><h3>${icon('shield-x')} Guard blocked this request</h3><p>${esc(entry.response.reason)}</p><p class="small">Event ID: <code>${esc(entry.response.eventId)}</code></p><button type="button" class="text-button" data-go="guard">View Guard activity</button></section>`;
    else if (entry.response?.type === 'draft') content = `<p>${esc(entry.response.group.name)}</p>${draftTicket(entry.response.draft)}`;
    else if (entry.expense) content = `<div class="saved-ticket"><p class="success-stamp">Expense saved.</p><p>${formatUsdCents(entry.expense.totalCents)} · ${esc(entry.groupName)}</p><button type="button" class="text-button" data-group-id="${esc(entry.expense.groupId)}">View group ledger</button></div>`;
    else if (entry.response?.type === 'answer') {
      content = `<p>${esc(entry.response.answer)}</p>`;
      if (entry.response.asOf) content += `<p class="small muted">Snapshot: ${esc(new Date(entry.response.asOf).toLocaleString())}${entry.response.balanceAsOf ? ` · Bank balance: ${esc(new Date(entry.response.balanceAsOf).toLocaleString())}` : ' · Bank balance not synced'}</p>`;
      if (entry.response.plan) content += `<div class="ask-plan">${entry.response.plan.groups.filter((g) => g.debts.length).map((g) => `<section><h3>${esc(g.name)}</h3>${g.debts.map((d) => `<p>${esc(d.displayName)} · ${formatUsdCents(d.cents)} · ${({ fits: 'Fits this plan', does_not_fit: 'Does not fit', pending: 'Payment pending' })[d.recommendation]}</p>`).join('')}</section>`).join('')}</div>`;
      if (entry.response.debts) content += `<div class="ask-plan">${entry.response.groups.map((g) => {
        const debts = entry.response.debts.filter((d) => d.groupId === g.id);
        return debts.length ? `<section><h3>${esc(g.name)}</h3>${debts.map((d) => `<p>${d.cents > 0 ? 'You owe' : 'You are owed'} ${formatUsdCents(Math.abs(d.cents))} ${d.cents > 0 ? 'to' : 'by'} ${esc(d.displayName)}.</p>`).join('')}</section>` : '';
      }).join('')}</div>`;
      if (entry.response.asOf) content += `<button type="button" class="text-button" data-ask-action="retry" data-entry-id="${entry.id}" ${entry.pending ? 'disabled' : ''}>Refresh facts</button>`;
    }
    return `<div class="user-message">${esc(entry.message)}</div><div class="agent-message" data-ask-entry="${entry.id}">${label}${content}
      ${entry.pending ? '<p role="status">Working on your request…</p>' : ''}
      ${entry.error ? `<p role="alert">${esc(entry.error)}</p>${entry.retryBody ? `<button type="button" class="text-button" data-ask-action="retry" data-entry-id="${entry.id}">Retry</button>` : ''}` : ''}</div>`;
  }

  function chat() {
    return heading('Ask Split', 'Money talk. Less awkward.', 'Review a shared expense before saving it.') +
      `<div class="chat-thread">${entries.length ? entries.map(entryHtml).join('') : `<div class="agent-message">${label}<p>Tell me what you spent and who to split it with.</p></div>`}</div>
      <div class="composer-area"><form class="composer" id="sp-chat-form"><label for="sp-chat-input" class="sr-only">Message Split</label>
      <input id="sp-chat-input" name="message" placeholder="Spent $42 at Antonio’s, split with Sam and Priya" autocomplete="off" maxlength="500" value="${esc(composerText)}" ${sending ? 'disabled' : ''} required>
      <button type="submit" class="icon-button send" aria-label="Send message" ${sending ? 'disabled' : ''}>${icon('arrow-up')}</button></form>
      <p class="chat-footnote">Only your confirmation saves an expense. No money is transferred.</p></div>`;
  }

  function receive(entry, response) {
    entry.response = response;
    if (response.type === 'draft') {
      registerReview(response.draft, {
        onConfirmed: (expense) => {
          entry.response = null;
          entry.expense = expense;
          entry.groupName = response.group.name;
          refresh();
          announce('Expense saved. The group ledger has been updated.');
        },
        onDiscard: () => {
          entry.response = { type: 'answer', answer: 'Review discarded. No ledger entry was added.' };
          refresh();
        },
      });
      announce('Expense draft ready. Review the shares before confirming.');
    } else if (response.type === 'selection_needed') announce('Choose the expense group, members, and missing details.');
    else if (response.type === 'blocked') announce(`${response.reason} Guard event ${response.eventId}.`);
  }

  async function request(entry, body) {
    if (entry.pending) return;
    entry.pending = true;
    entry.error = '';
    entry.retryBody = body;
    const revision = financialRevision();
    refresh();
    try {
      const response = await apiRequest('/api/ask', { method: 'POST', body, timeoutMs: 60_000 });
      if (response.asOf && revision !== financialRevision()) throw new Error('Your financial facts changed while Split was answering. Refresh to get the current figures.');
      receive(entry, response);
    } catch (error) {
      entry.error = error.name === 'TimeoutError' ? 'The request took too long. Try again when you are ready.'
        : error.message || 'The request could not finish. Try again.';
      announce(entry.error);
    } finally { entry.pending = false; refresh(); }
  }

  subscribeFinancialChanges(() => {
    for (const entry of entries) {
      if (!entry.response?.asOf) continue;
      entry.response = null;
      entry.error = 'Your financial facts changed. Refresh to get the current figures.';
    }
    refresh();
  });

  function rememberValues(entry, form) {
    const fd = new FormData(form);
    entry.values = { merchant: String(fd.get('merchant') || ''), amount: String(fd.get('amount') || '') };
    return fd;
  }

  function selectionBody(entry, groupId, includeMembers, form) {
    const fd = rememberValues(entry, form);
    const selection = { groupId };
    if (entry.values.merchant.trim()) selection.merchant = entry.values.merchant.trim();
    if (entry.values.amount.trim()) selection.cents = usdToCents(entry.values.amount.trim());
    if (includeMembers) selection.participantIds = fd.getAll('participant');
    return { proposalId: entry.response.proposalId, selection };
  }

  async function submitMessage(text, context = null) {
    const message = text.trim();
    if (!message || sending) return;
    const previous = entries.at(-1);
    const retry = previous?.error && previous.message === message && previous.retryBody?.message === message &&
      JSON.stringify(previous.retryBody?.context ?? null) === JSON.stringify(context);
    const entry = retry ? previous : { id: ++nextId, message, pending: false, error: '' };
    if (!retry) entries.push(entry);
    composerText = message;
    sending = true;
    await request(entry, retry ? entry.retryBody : { message, requestKey: crypto.randomUUID(), ...(context ? { context } : {}) });
    if (!entry.error) composerText = '';
    sending = false;
    refresh();
    if (state.page === 'chat') root.querySelector('#sp-chat-input')?.focus({ preventScroll: true });
  }

  function handleAskForm(form, fd) {
    if (form.id === 'sp-chat-form') { void submitMessage(String(fd.get('message') || '')); return; }
    if (!form.hasAttribute('data-ask-selection')) return;
    const entry = entries.find((value) => String(value.id) === form.dataset.askSelection);
    if (!entry || entry.pending) return;
    try { void request(entry, selectionBody(entry, String(fd.get('groupId')), true, form)); } catch (error) {
      entry.error = error.message; entry.retryBody = null; refresh();
    }
  }

  root.addEventListener('input', (event) => {
    if (event.target.id === 'sp-chat-input') composerText = event.target.value;
  });
  root.addEventListener('change', (event) => {
    if (!event.target.hasAttribute('data-ask-group') || !event.target.value) return;
    const entry = entries.find((value) => String(value.id) === event.target.dataset.askGroup);
    if (!entry || entry.pending) return;
    try { void request(entry, selectionBody(entry, event.target.value, false, event.target.form)); } catch (error) {
      entry.error = error.message; entry.retryBody = null; refresh();
    }
  });
  root.addEventListener('click', (event) => {
    const note = event.target.closest('[data-ask-note-group]');
    if (note) {
      go('chat');
      void submitMessage('Check whether this group note can authorize an action.', { kind: 'group_note', groupId: note.dataset.askNoteGroup });
      return;
    }
    const button = event.target.closest('[data-ask-action]');
    if (!button) return;
    const entry = entries.find((value) => String(value.id) === button.dataset.entryId);
    if (!entry || entry.pending) return;
    if (button.dataset.askAction === 'retry' && entry.retryBody) void request(entry, entry.retryBody);
    if (button.dataset.askAction === 'create-group') {
      rememberValues(entry, button.closest('section').querySelector('form'));
      const selection = {};
      try {
        if (entry.values.merchant.trim()) selection.merchant = entry.values.merchant.trim();
        if (entry.values.amount.trim()) selection.cents = usdToCents(entry.values.amount.trim());
      } catch (error) { entry.error = error.message; entry.retryBody = null; refresh(); return; }
      openGroupCreation({ onCreated: (group) => request(entry, {
        proposalId: entry.response.proposalId, selection: { ...selection, groupId: group.id },
      }) });
    }
  });
  return { chat, handleAskForm };
}
