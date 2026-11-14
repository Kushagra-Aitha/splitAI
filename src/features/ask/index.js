import { apiRequest, getSession } from '../../api/session.js';
import { usdToCents, centsToUsdText, formatUsdCents } from '../../lib/money.js';
import { financialRevision, subscribeFinancialChanges } from '../../api/financial-state.js';
import { preserveFocus } from '../../lib/focus.js';
import { createAskPanel } from './panel.js';

export function createAsk({ root, state, icon, icons, esc, heading, render, announce, go,
  draftTicket, registerReview, openGroupCreation }) {
  const entries = [];
  let composerText = '';
  let sending = false;
  let nextId = 0;
  let epoch = 0;
  const controllers = new Set();
  const actorId = getSession()?.actor.userId;
  const owned = () => !!actorId && getSession()?.actor.userId === actorId;
  const prompts = ["Split last night's Domino's with Flat 7", 'What do I owe?', 'Food spending this month'];
  const panel = createAskPanel({ root, icon, icons, renderChat: () => chat(true) });
  const label = '<div class="agent-label"><span class="agent-mark" aria-hidden="true"><span class="brand-mark"></span></span>Split<span class="tag">AI assistant</span></div>';
  const refresh = () => {
    if (!owned()) return;
    if (panel.isOpen()) panel.refresh();
    else if (state.page === 'chat') preserveFocus(root, render);
  };
  function focusResponse(entry) {
    if (!panel.isOpen() && state.page !== 'chat') return;
    const doc = root.ownerDocument;
    if (doc.activeElement !== doc.body) return;
    root.querySelector(`#sp-ask-${entry.error ? 'error' : 'result'}-${entry.id}`)?.focus({ preventScroll: true });
  }

  function selectionCard(entry) {
    const data = entry.response;
    const values = entry.values || {};
    const merchant = values.merchant ?? data.extraction.merchant ?? '';
    const amount = values.amount ?? (data.extraction.cents === null ? '' : centsToUsdText(data.extraction.cents));
    const selected = values.memberGroupId === data.groupId ? values.participantIds : data.suggestedParticipantIds;
    const names = data.unresolvedNames.length ? `<p>Choose the correct group members for: ${esc(data.unresolvedNames.join(', '))}.</p>` : '';
    return `<section class="ask-selection" aria-label="Choose expense details"><p>Choose the group and people, then review the split.</p>${names}
      <form data-ask-selection="${entry.id}" aria-describedby="sp-ask-error-${entry.id}" aria-busy="${entry.pending}"><fieldset ${entry.pending ? 'disabled' : ''}>
      <label class="field">Group<select id="sp-ask-group-${entry.id}" name="groupId" data-ask-group="${entry.id}" required><option value="">Choose a group</option>
      ${data.groups.map((group) => `<option value="${esc(group.id)}" ${group.id === data.groupId ? 'selected' : ''}>${esc(group.name)}</option>`).join('')}</select></label>
      ${data.requiresBankPurchase ? `<label class="field">Matching bank purchase<select id="sp-ask-bank-${entry.id}" name="bankPurchase" data-ask-bank="${entry.id}" required><option value="">Choose a purchase</option>
        ${(data.bankCandidates || []).map((purchase, index) => `<option value="${index}" ${data.selectedBankRef?.accountId === purchase.accountId && data.selectedBankRef?.providerKey === purchase.providerKey ? 'selected' : ''}>${esc(purchase.merchant || merchant)} · ${formatUsdCents(purchase.cents)} · ${esc(new Date(purchase.occurredAt).toLocaleString())} · ${esc(purchase.accountKind)} ••${esc(purchase.mask || '••••')}</option>`).join('')}</select></label>
        ${!data.bankCandidates?.length ? '<p>No matching unsplit purchase was found in your shared bank accounts. Sync your bank or refine the merchant/date in a new message.</p>' : '<p class="small muted">The bank supplies the merchant and amount. You still choose the group and participants.</p>'}` : ''}
      <div class="field-grid"><label class="field">Merchant<input id="sp-ask-merchant-${entry.id}" name="merchant" value="${esc(merchant)}" maxlength="60" ${data.requiresBankPurchase ? 'readonly' : ''} required></label>
      <label class="field">Total, USD<input id="sp-ask-amount-${entry.id}" name="amount" inputmode="decimal" value="${esc(amount)}" maxlength="20" ${data.requiresBankPurchase ? 'readonly' : ''} aria-invalid="${entry.invalidField === 'amount'}" aria-describedby="sp-ask-error-${entry.id}" required></label></div>
      ${data.members.length ? `<fieldset><legend>Split with</legend>${data.members.map((member) => `<label class="check-label"><input id="sp-ask-member-${entry.id}-${esc(member.userId)}" type="checkbox" name="participant" value="${esc(member.userId)}" ${member.isYou || selected?.includes(member.userId) ? 'checked' : ''} ${member.isYou ? 'disabled' : ''}>${esc(member.fullName || member.displayName)}${member.handle ? ` (@${esc(member.handle)})` : ''}${member.isYou ? ' · You, the payer' : ''}</label>`).join('')}</fieldset>` : ''}
      <div class="ask-selection-actions"><button id="sp-ask-review-${entry.id}" type="submit" class="primary" ${!data.groupId ? 'disabled' : ''}>Review split</button>
      <button id="sp-ask-create-${entry.id}" type="button" class="secondary" data-ask-action="create-group" data-entry-id="${entry.id}">Create a group</button></div></fieldset></form></section>`;
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
    return `<div class="user-message">${esc(entry.message)}</div><div class="agent-message" id="sp-ask-result-${entry.id}" role="region" aria-label="Split response" tabindex="-1" aria-busy="${entry.pending}" data-ask-entry="${entry.id}">${label}${content}
      ${entry.pending ? '<p role="status">Working on your request…</p>' : ''}
      <p id="sp-ask-error-${entry.id}" role="alert" aria-atomic="true" tabindex="-1">${esc(entry.error)}</p>
      ${entry.error && entry.retryBody ? `<button id="sp-ask-retry-${entry.id}" type="button" class="text-button" data-ask-action="retry" data-entry-id="${entry.id}">Retry</button>` : ''}</div>`;
  }

  function chat(compact = false) {
    return (compact ? '' : heading('Ask Split', 'Money talk. Less awkward.', 'Review a shared expense before saving it.')) +
      `<div class="chat-thread">${entries.length ? entries.map(entryHtml).join('') : `<div class="agent-message">${label}<p>Tell me what you spent and who to split it with.</p></div>`}</div>
      <div class="composer-area"><div class="ask-prompts" aria-label="Suggested questions">${prompts.map((prompt, index) => `<button type="button" class="text-button" data-ask-prompt="${index}" ${sending ? 'disabled' : ''}>${esc(prompt)}</button>`).join('')}</div><form class="composer" id="sp-chat-form" aria-busy="${sending}"><label for="sp-chat-input" class="sr-only">Message Split</label>
      <input id="sp-chat-input" name="message" aria-describedby="sp-chat-help" placeholder="Spent $42 at Antonio’s, split with Sam and Priya" autocomplete="off" maxlength="500" value="${esc(composerText)}" ${sending ? 'disabled' : ''} required>
      <button type="submit" class="icon-button send" aria-label="Send message" ${sending ? 'disabled' : ''}>${icon('arrow-up')}</button></form>
      <p id="sp-chat-help" class="chat-footnote">Only your confirmation saves an expense. No money is transferred.</p></div>`;
  }

  function receive(entry, response) {
    entry.response = response;
    if (response.type === 'selection_needed' && response.requiresBankPurchase && response.selectedBankRef && entry.values) {
      entry.values.merchant = response.extraction.merchant;
      entry.values.amount = centsToUsdText(response.extraction.cents);
    }
    if (response.type === 'draft') {
      registerReview(response.draft, {
        onConfirmed: (expense) => {
          entry.response = null;
          entry.expense = expense;
          entry.groupName = response.group.name;
          refresh();
          focusResponse(entry);
          announce('Expense saved. The group ledger has been updated.');
        },
        onDiscard: () => {
          entry.response = { type: 'answer', answer: 'Review discarded. No ledger entry was added.' };
          refresh();
          focusResponse(entry);
        },
      });
      announce('Expense draft ready. Review the shares before confirming.');
    } else if (response.type === 'selection_needed') announce('Choose the expense group, members, and missing details.');
    else if (response.type === 'blocked') announce(`${response.reason} Guard event ${response.eventId}.`);
  }

  async function request(entry, body) {
    if (entry.pending || !owned()) return;
    const generation = epoch, controller = new AbortController(); controllers.add(controller);
    entry.pending = true;
    entry.error = '';
    entry.retryBody = body;
    const revision = financialRevision();
    refresh();
    announce('Working on your request.');
    try {
      const response = await apiRequest('/api/ask', { method: 'POST', body, timeoutMs: 60_000, signal: controller.signal });
      if (generation !== epoch || !owned()) return;
      if (response.asOf && revision !== financialRevision()) throw new Error('Your financial facts changed while Split was answering. Refresh to get the current figures.');
      receive(entry, response);
    } catch (error) {
      if (generation !== epoch || controller.signal.aborted) return;
      if (!owned() || error.status === 401) { reset(); return; }
      entry.error = error.name === 'TimeoutError' ? 'The request took too long. Try again when you are ready.'
        : error.message || 'The request could not finish. Try again.';
      announce(entry.error);
    } finally {
      controllers.delete(controller);
      if (generation === epoch && owned()) { entry.pending = false; refresh(); if (!sending) focusResponse(entry); }
    }
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
    entry.values = { merchant: String(fd.get('merchant') || ''), amount: String(fd.get('amount') || ''),
      participantIds: fd.getAll('participant'), memberGroupId: entry.response.groupId };
    return fd;
  }

  function selectionBody(entry, groupId, includeMembers, form) {
    const fd = rememberValues(entry, form);
    const selection = groupId ? { groupId } : {};
    if (entry.response.requiresBankPurchase) {
      const selected = fd.get('bankPurchase');
      const purchase = selected !== null && selected !== '' ? entry.response.bankCandidates[Number(selected)] : null;
      if (purchase) selection.bankRef = { accountId: purchase.accountId, providerKey: purchase.providerKey };
    }
    if (!entry.response.requiresBankPurchase && entry.values.merchant.trim()) selection.merchant = entry.values.merchant.trim();
    if (!entry.response.requiresBankPurchase && entry.values.amount.trim()) {
      try { selection.cents = usdToCents(entry.values.amount.trim()); } catch (error) { entry.invalidField = 'amount'; throw error; }
    }
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
    if (!owned()) return;
    if (!entry.error) composerText = '';
    sending = false;
    refresh();
    focusResponse(entry);
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
    const form = event.target.closest('form[data-ask-selection]');
    if (form) {
      const entry = entries.find((value) => String(value.id) === form.dataset.askSelection);
      if (entry && !entry.pending) rememberValues(entry, form);
      if (entry && event.target.name === entry.invalidField) {
        entry.invalidField = null;
        event.target.removeAttribute('aria-invalid');
      }
    }
  });
  root.addEventListener('change', (event) => {
    if (event.target.hasAttribute('data-ask-bank') && event.target.value !== '') {
      const entry = entries.find((value) => String(value.id) === event.target.dataset.askBank);
      if (!entry || entry.pending) return;
      try { void request(entry, selectionBody(entry, event.target.form.elements.groupId.value, false, event.target.form)); }
      catch (error) { entry.error = error.message; entry.retryBody = null; refresh(); }
      return;
    }
    if (!event.target.hasAttribute('data-ask-group') || !event.target.value) return;
    const entry = entries.find((value) => String(value.id) === event.target.dataset.askGroup);
    if (!entry || entry.pending) return;
    try { void request(entry, selectionBody(entry, event.target.value, false, event.target.form)); } catch (error) {
      entry.error = error.message; entry.retryBody = null; refresh();
    }
  });
  root.addEventListener('click', (event) => {
    const prompt = event.target.closest('[data-ask-prompt]');
    if (prompt && !sending) { composerText = prompts[Number(prompt.dataset.askPrompt)] || ''; refresh(); root.querySelector('#sp-chat-input')?.focus(); return; }
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
  function reset() {
    epoch++; for (const controller of controllers) controller.abort(); controllers.clear();
    entries.length = 0; composerText = ''; sending = false; panel.clear();
  }
  root.addEventListener('click', (event) => { if (event.target.closest('#sp-logout')) reset(); }, true);
  window.addEventListener('pagehide', reset, { once: true });
  return { chat, handleAskForm, open() { if (owned()) panel.open(); else reset(); }, close: panel.close, isOpen: panel.isOpen };
}
