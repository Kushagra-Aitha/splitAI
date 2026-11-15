import { apiRequest, getSession } from '../../api/session.js';
import { usdToCents, centsToUsdText, formatUsdCents } from '../../lib/money.js';
import { financialRevision, subscribeFinancialChanges } from '../../api/financial-state.js';
import { preserveFocus } from '../../lib/focus.js';
import { canReadAloud, readAloud, stopReading } from '../../lib/read-aloud.js';
import { createRecordedTalk } from './recorded-talk.js';
import { createPushToTalk } from './push-to-talk.js';
import { createAskPanel } from './panel.js';
import { buildAskPrompts } from './suggestions.js';

export function createAsk({ root, state, icon, icons, esc, heading, render, announce, go,
  draftTicket, registerReview, openGroupCreation, openSettlement }) {
  const entries = [];
  let composerText = '';
  let sending = false;
  let nextId = 0;
  let epoch = 0;
  const controllers = new Set();
  const actorId = getSession()?.actor.userId;
  const contextKey = 'split.ask.session-context';
  const emptyFocus = () => ({ categories: [], merchants: [] });
  const validFocus = (value) => value && typeof value === 'object' && !Array.isArray(value) &&
    Array.isArray(value.categories) && Array.isArray(value.merchants) &&
    value.categories.length <= 5 && value.merchants.length <= 5 &&
    value.categories.every((entry) => typeof entry === 'string' && entry.trim()) &&
    value.merchants.every((entry) => typeof entry === 'string' && entry.trim()) &&
    Object.keys(value).length === 2;
  const validTopic = (value) => value && typeof value === 'object' && !Array.isArray(value) &&
    ['intent', 'merchant', 'category', 'from', 'to', 'focus'].every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).length === 6 && typeof value.intent === 'string' &&
    ['merchant', 'category', 'from', 'to'].every((key) => value[key] === null || typeof value[key] === 'string') &&
    validFocus(value.focus);
  const loadTopics = () => {
    try {
      const stored = JSON.parse(sessionStorage.getItem(contextKey) || 'null');
      return stored?.actorId === actorId && Array.isArray(stored.topics) ? stored.topics.filter(validTopic).slice(-4) : [];
    } catch { return []; }
  };
  let topics = loadTopics();
  const owned = () => !!actorId && getSession()?.actor.userId === actorId;
  let prompts = buildAskPrompts();
  let promptProfile = null;
  const panel = createAskPanel({ root, icon, icons, renderChat: () => chat(true), onClose: stopVoice });
  let voiceState = 'idle';
  let voiceMessage = '';
  let speakReplies = false;
  let pointer = null;
  let heldKey = null;
  const voiceCallbacks = {
    onState(value) {
      voiceState = value;
      if (value !== 'idle') voiceMessage = '';
      else { pointer = null; heldKey = null; }
      paintVoice();
    },
    onTranscript(transcript, { basic = false } = {}) {
      if (!askVisible() || sending) return;
      if (composerText.trim()) {
        composerText = `${composerText.trim()} ${transcript}`.slice(0, 500);
        refresh();
        announceVoice('Voice input added. Review your message, then send it.');
      } else if (transcript.length > 500) {
        composerText = transcript.slice(0, 500);
        refresh();
        announceVoice('Voice input reached 500 characters. Review it before sending.');
      } else {
        void submitMessage(transcript, null, basic);
      }
    },
    onError: announceVoice,
  };
  const recorder = createRecordedTalk(voiceCallbacks);
  const voice = recorder.supported ? recorder : createPushToTalk({
    ...voiceCallbacks,
    Recognition: [window.SpeechRecognition, window.webkitSpeechRecognition].find((candidate) => typeof candidate === 'function'),
  });
  const micHeld = () => voiceState === 'permission' || voiceState === 'listening';

  function askVisible() {
    return owned() && !document.hidden && (panel.isOpen() || state.page === 'chat') &&
      !root.querySelector('#sp-modal-root').children.length;
  }

  function voiceStatus() {
    if (!voice.supported) return 'This browser session has no speech recognition. You can still type.';
    if (voiceState === 'permission') return 'Opening microphone…';
    return voiceState === 'listening' ? 'Listening…' : voiceState === 'processing' ? 'Transcribing…' : voiceMessage;
  }

  function paintVoice() {
    for (const button of root.querySelectorAll('[data-ask-mic]')) {
      button.setAttribute('aria-pressed', String(micHeld()));
      button.disabled = !voice.supported || sending || voiceState === 'processing';
    }
    for (const status of root.querySelectorAll('[data-ask-voice-status]')) status.textContent = voiceStatus();
  }

  function announceVoice(message) {
    voiceMessage = message;
    paintVoice();
  }

  function stopVoice() {
    voiceMessage = '';
    voice.cancel();
    stopReading('ask');
  }

  function startVoice() {
    if (!askVisible() || sending || voiceState !== 'idle') return false;
    stopReading();
    return voice.start();
  }

  function replyText(response) {
    if (response.type === 'answer') return response.answer;
    if (response.type === 'reminder_draft') return 'Your reminder is ready for review. Select Send reminder to confirm it.';
    if (response.type === 'reminder_selection') return response.answer;
    if (response.type === 'reminder_sent') return 'Reminder sent.';
    if (response.type === 'clarification') return response.answer;
    if (response.type === 'draft') return 'Your expense split is ready for review.';
    if (response.type === 'selection_needed') return 'Choose the expense details, then review your split.';
    if (response.type === 'blocked') return response.reason;
    return null;
  }
  const label = '<div class="agent-label"><span class="agent-mark" aria-hidden="true"><span class="brand-mark"></span></span>Split<span class="tag">AI assistant</span></div>';
  const refresh = () => {
    if (!owned()) return;
    if (panel.isOpen()) panel.refresh();
    else if (state.page === 'chat') preserveFocus(root, render);
  };
  function rebuildPrompts() {
    const exclude = entries.map((entry) => entry.message).filter((value) => typeof value === 'string').slice(-4);
    prompts = buildAskPrompts({ topics, ...promptProfile, exclude });
  }
  function promptLabel(prompt) {
    return typeof prompt === 'string' ? prompt : prompt?.label;
  }
  async function refreshPrompts() {
    if (!owned()) return;
    const [groups, transactions, goals] = await Promise.allSettled([
      apiRequest('/api/groups'),
      apiRequest('/api/banking/transactions?offset=0'),
      apiRequest('/api/goals'),
    ]);
    if (!owned()) return;
    promptProfile = {
      groups: groups.status === 'fulfilled' && Array.isArray(groups.value?.groups) ? groups.value.groups : [],
      transactions: transactions.status === 'fulfilled' && Array.isArray(transactions.value?.transactions) ? transactions.value.transactions : [],
      goals: goals.status === 'fulfilled' && Array.isArray(goals.value?.goals) ? goals.value.goals : [],
    };
    rebuildPrompts();
    refresh();
  }
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

  function goalAnswers(goals) {
    const labels={funded:'Target reached',no_date:'At your own pace',on_track:'On track · estimate',short:'Below target pace · estimate'};
    return `<div class="ask-goal-list">${goals.map(g=>{
      if(!Number.isSafeInteger(g.savedCents)||!Number.isSafeInteger(g.targetCents)||g.targetCents<=0)return '<p>Goal details need a refresh.</p>';
      const percent=Number(BigInt(g.savedCents)*100n/BigInt(g.targetCents));
      return `<section class="ask-goal-answer"><div class="ask-goal-heading"><h3>${esc(g.name)}</h3><span class="tag">${esc(labels[g.status]||'Saved progress')}</span></div><p class="ask-goal-amount"><strong>${formatUsdCents(g.savedCents)}</strong> <span>of ${formatUsdCents(g.targetCents)}</span></p><progress max="100" value="${Math.min(100,percent)}" aria-label="${esc(g.name)} ${percent}% funded"></progress><p class="small muted">${g.targetDate ? `Target ${esc(new Date(g.targetDate+'T12:00:00Z').toLocaleDateString())}` : 'No target date set'}${Number.isSafeInteger(g.requiredCentsPerDay)&&g.remainingCents>0 ? ` · ${formatUsdCents(g.requiredCentsPerDay)} per day needed` : ''}</p></section>`;
    }).join('')}</div>`;
  }

  function entryHtml(entry) {
    let content = '';
    if (entry.response?.type === 'selection_needed') content = selectionCard(entry);
    else if (entry.response?.type === 'reminder_selection') content = `<section class="ask-reminder-choices" aria-label="Choose a reminder"><p>${esc(entry.response.answer)}</p>${entry.response.candidates.map((candidate, index) => `<button type="button" class="secondary" data-ask-action="reminder-select" data-entry-id="${entry.id}" data-candidate="${index}" ${entry.pending ? 'disabled' : ''}>${esc(candidate.recipientName)} · ${esc(candidate.groupName)} · ${formatUsdCents(candidate.amountCents)} owed · ${esc(candidate.merchant)}</button>`).join('')}</section>`;
    else if (entry.response?.type === 'reminder_draft') {
      const r = entry.response.reminder;
      content = r.status === 'sent' ? '<p role="status">Reminder already sent. No money moved.</p>' : `<section class="ask-reminder-review" aria-label="Review reminder"><h3>Review reminder</h3><p>Remind ${esc(r.recipientName)} about ${formatUsdCents(r.amountCents)} owed to you in ${esc(r.groupName)}${r.merchant ? ` · related to ${esc(r.merchant)}` : ''}?</p><p class="small muted">This is the outstanding group balance between you, not a second charge for the expense. No money moves. At most one reminder per person and group debt each day.</p><button type="button" class="primary" data-ask-action="reminder-confirm" data-entry-id="${entry.id}" ${entry.pending ? 'disabled' : ''}>${entry.pending ? 'Sending reminder…' : 'Send reminder'}</button> <button type="button" class="secondary" data-ask-action="reminder-cancel" data-entry-id="${entry.id}" ${entry.pending ? 'disabled' : ''}>Cancel</button></section>`;
    }
    else if (entry.response?.type === 'reminder_sent') content = `<div class="ask-success" role="status">${icon('check')}<div><h3>Reminder sent</h3><p>No money moved.</p></div></div>`;
    else if (entry.response?.type === 'clarification') content = `<section class="ask-clarification"><p>${esc(entry.response.answer)}</p>
      <div class="ask-selection-actions">${entry.response.choices.map((choice, index) =>
        `<button type="button" class="secondary" data-ask-action="clarification-choice" data-entry-id="${entry.id}" data-choice="${index}">${esc(choice.label)}</button>`).join('')}</div></section>`;
    else if (entry.response?.type === 'blocked') content = `<section class="ask-blocked" role="status" aria-label="Guard blocked this request"><h3>${icon('shield-x')} Guard blocked this request</h3><p>${esc(entry.response.reason)}</p><p class="small">Event ID: <code>${esc(entry.response.eventId)}</code></p><button type="button" class="text-button" data-go="guard">View Guard activity</button></section>`;
    else if (entry.response?.type === 'draft') content = `<p>${esc(entry.response.group.name)}</p>${draftTicket(entry.response.draft)}`;
    else if (entry.expense) content = `<div class="saved-ticket"><p class="success-stamp">Expense saved.</p><p>${formatUsdCents(entry.expense.totalCents)} · ${esc(entry.groupName)}</p><button type="button" class="text-button" data-group-id="${esc(entry.expense.groupId)}">View group ledger</button></div>`;
    else if (entry.response?.type === 'answer') {
      if (entry.response.goals?.length) content = `<p>Here’s your confirmed savings progress.</p>${goalAnswers(entry.response.goals)}`;
      else if (entry.response.transactions?.length) {
        content = `<div class="ask-plan" aria-label="${esc(entry.response.answer)}">${entry.response.transactions.map((transaction) =>
          `<section><h3>${esc(transaction.merchant)}</h3><p>${formatUsdCents(transaction.amountCents)} · ${esc(transaction.category)} · ${esc(transaction.status)} · ${esc(new Date(transaction.occurredAt).toLocaleDateString())}</p></section>`).join('')}</div>`;
      } else content = `<p class="ask-answer-copy">${esc(entry.response.answer)}</p>`;
      if (entry.response.asOf) content += `<p class="small muted">Snapshot: ${esc(new Date(entry.response.asOf).toLocaleString())}${['goal_progress', 'explain_charge'].includes(entry.response.intent) ? '' : entry.response.balanceAsOf ? ` · Bank balance: ${esc(new Date(entry.response.balanceAsOf).toLocaleString())}` : ' · Bank balance not synced'}</p>`;
      if (entry.response.plan) content += `<div class="ask-plan">${entry.response.plan.groups.filter((g) => g.debts.length).map((g) => `<section><h3>${esc(g.name)}</h3>${g.debts.map((d) => `<p>${esc(d.displayName)} · ${formatUsdCents(d.cents)} · ${({ fits: 'Fits this plan', does_not_fit: 'Does not fit', pending: 'Payment pending' })[d.recommendation]}</p>`).join('')}</section>`).join('')}</div>`;
      if (entry.response.debts) content += `<div class="ask-plan">${entry.response.groups.map((g) => {
        const debts = entry.response.debts.filter((d) => d.groupId === g.id);
        return debts.length ? `<section><h3>${esc(g.name)}</h3>${debts.map((d) => `<p>${d.cents > 0 ? 'You owe' : 'You are owed'} ${formatUsdCents(Math.abs(d.cents))} ${d.cents > 0 ? 'to' : 'by'} ${esc(d.displayName)}.${d.cents > 0 ? ` <button type="button" class="text-button" data-ask-settle-group="${esc(g.id)}" data-ask-settle-user="${esc(d.userId)}">Settle up</button>` : ''}</p>`).join('')}</section>` : '';
      }).join('')}</div>`;
      if (entry.response.paceNote) content += `<p class="small muted">${esc(entry.response.paceNote)}</p><button type="button" class="text-button" data-go="goals">Open Goals</button>`;
      if (entry.response.asOf) content += `<button type="button" class="text-button" data-ask-action="retry" data-entry-id="${entry.id}" ${entry.pending ? 'disabled' : ''}>Refresh facts</button>`;
    }
    return `<div class="user-message">${esc(entry.message)}</div><div class="agent-message" id="sp-ask-result-${entry.id}" role="region" aria-label="Split response" tabindex="-1" aria-busy="${entry.pending}" data-ask-entry="${entry.id}">${label}${content}
      ${entry.pending ? '<p class="ask-working" role="status"><span aria-hidden="true">● ● ●</span> Working on your request…</p>' : ''}
      <p id="sp-ask-error-${entry.id}" role="alert" aria-atomic="true" tabindex="-1">${esc(entry.error)}</p>
      ${entry.error && entry.retryBody ? `<button id="sp-ask-retry-${entry.id}" type="button" class="text-button" data-ask-action="retry" data-entry-id="${entry.id}">Retry</button>` : ''}</div>`;
  }

  function chat(compact = false) {
    return (compact ? '' : heading('Ask Split', 'Let’s talk money.', 'Check a balance, plan a goal, or prepare a shared expense.')) +
      `<div class="chat-thread">${entries.length ? entries.map(entryHtml).join('') : `<div class="agent-message ask-welcome">${label}<h2>A little clarity, before your next move.</h2><p>Ask what you owe, check your goals, or review a charge. You stay in charge of every action.</p></div>`}</div>
      <div class="composer-area"><div class="ask-prompts" aria-label="Suggested questions">${prompts.map((prompt, index) => `<button type="button" class="text-button" data-ask-prompt="${index}" ${sending ? 'disabled' : ''}>${esc(promptLabel(prompt))}</button>`).join('')}</div><form class="composer" id="sp-chat-form" aria-busy="${sending}"><label for="sp-chat-input" class="sr-only">Message Split</label>
      <textarea rows="2" id="sp-chat-input" name="message" aria-describedby="sp-chat-help" placeholder="Spent $42 at Antonio’s, split with Sam and Priya" autocomplete="off" maxlength="500" ${sending ? 'disabled' : ''} required>${esc(composerText)}</textarea>
      <button type="button" class="icon-button ask-mic" id="sp-ask-mic" data-ask-mic
        aria-label="${voice.supported ? 'Microphone, hold to talk' : 'Microphone unavailable'}"
        aria-pressed="${micHeld()}" aria-describedby="sp-ask-voice-status"
        ${!voice.supported || sending || voiceState === 'processing' ? 'disabled' : ''}>${icon('microphone')}</button>
      <button type="submit" class="icon-button send" aria-label="Send message" ${sending ? 'disabled' : ''}>${icon('arrow-up')}</button></form>
      <div class="ask-voice-options">
        ${canReadAloud() ? `<button type="button" class="text-button" id="sp-ask-speech" data-ask-speech aria-pressed="${speakReplies}">${icon('speaker-high')} Spoken replies ${speakReplies ? 'on' : 'off'}</button>` : ''}
        <span class="small" id="sp-ask-voice-status" data-ask-voice-status role="status">${esc(voiceStatus())}</span>
      </div>
      <p id="sp-chat-help" class="chat-footnote">${recorder.supported ? 'Hold the mic to talk. Recordings are sent for transcription. ' : ''}Enter to send · Shift + Enter for a new line. Expenses and reminders need confirmation; payments have a separate review.</p></div>`;
  }

  function receive(entry, response) {
    entry.response = response;
    const supplied = response.conversation;
    const intent = supplied?.intent || response.intent ||
      (['selection_needed', 'draft'].includes(response.type) ? 'expense' : null);
    if (intent && response.type !== 'blocked') {
      const range = response.spending?.range;
      const focus = validFocus(supplied?.focus) ? supplied.focus : emptyFocus();
      const topic = {
        intent,
        merchant: supplied?.merchant ?? response.extraction?.merchant ?? response.draft?.merchant ?? null,
        category: supplied?.category ?? response.category ?? null,
        from: supplied?.from ?? range?.from ?? null,
        to: supplied?.to ?? range?.to ?? null,
        focus,
      };
      if (validTopic(topic)) {
        topics = [...topics, topic].slice(-4);
        try { sessionStorage.setItem(contextKey, JSON.stringify({ actorId, topics })); } catch {}
      }
      rebuildPrompts();
    } else if (entry.message) {
      rebuildPrompts();
    }
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
    else if (response.type === 'reminder_draft') announce('Reminder ready to review. Nothing has been sent.');
    else if (response.type === 'reminder_sent') announce('Reminder sent. No money moved.');
    else if (response.type === 'reminder_selection') announce('Choose the person and group balance for the reminder.');
    else if (response.type === 'blocked') announce(`${response.reason} Guard event ${response.eventId}.`);
  }

  async function request(entry, body, path = '/api/ask') {
    if (entry.pending || !owned()) return;
    const generation = epoch, controller = new AbortController(); controllers.add(controller);
    entry.pending = true;
    entry.error = '';
    entry.retryBody = body; entry.retryPath = path;
    const revision = financialRevision();
    refresh();
    announce('Working on your request.');
    try {
      const response = await apiRequest(path, { method: 'POST', body, timeoutMs: 60_000, signal: controller.signal });
      if (generation !== epoch || !owned()) return;
      if (response.asOf && revision !== financialRevision()) throw new Error('Your financial facts changed while Split was answering. Refresh to get the current figures.');
      receive(entry, response);
      if (speakReplies && askVisible() && voiceState === 'idle') {
        readAloud(replyText(response), { owner: 'ask', onBasic: () => announceVoice('Using basic voice') });
      }
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

  async function submitMessage(text, context = null, basic = false, action = null) {
    const message = text.trim();
    if (!message || sending) return;
    voice.cancel();
    voiceMessage = basic ? 'Using basic voice' : '';
    stopReading();
    const previous = entries.at(-1);
    const retry = previous?.error && previous.message === message && previous.retryBody?.message === message &&
      JSON.stringify(previous.retryBody?.context ?? null) === JSON.stringify(context) &&
      JSON.stringify(previous.retryBody?.action ?? null) === JSON.stringify(action);
    const entry = retry ? previous : { id: ++nextId, message, pending: false, error: '' };
    if (!retry) entries.push(entry);
    composerText = message;
    sending = true;
    await request(entry, retry ? entry.retryBody : {
      message,
      requestKey: crypto.randomUUID(),
      ...(!context && topics.length ? { conversation: topics } : {}),
      ...(context ? { context } : {}),
      ...(action ? { action } : {}),
    }, retry ? entry.retryPath : '/api/ask');
    if (!owned()) return;
    if (!entry.error) composerText = '';
    sending = false;
    refresh();
    focusResponse(entry);
  }

  function submitPrompt(prompt) {
    if (!prompt) return;
    if (typeof prompt === 'string') {
      void submitMessage(prompt);
      return;
    }
    if (prompt.action?.type === 'expense_help') {
      const seed = prompt.action.groupName
        ? `Spent $42 at , split with  in ${prompt.action.groupName}`
        : 'Spent $42 at Antonio’s, split with Sam and Priya';
      composerText = seed;
      refresh();
      const input = root.querySelector('#sp-chat-input');
      if (input) {
        input.focus();
        const cursor = seed.indexOf(',') >= 0 ? Math.max(seed.indexOf('at ') + 3, 0) : seed.length;
        input.setSelectionRange(cursor, cursor);
      }
      announce(prompt.action.groupName
        ? `Add the merchant and people for ${prompt.action.groupName}, then send.`
        : 'Edit the example expense, then send.');
      return;
    }
    void submitMessage(prompt.label, null, false, prompt.action);
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

  root.addEventListener('pointerdown', (event) => {
    const button = event.target.closest('[data-ask-mic]');
    if (!button || event.button !== 0 || !event.isPrimary || !startVoice()) return;
    event.preventDefault();
    pointer = event.pointerId;
    button.focus();
  });
  window.addEventListener('pointerup', (event) => {
    if (event.pointerId === pointer) voice.release();
  });
  window.addEventListener('pointercancel', (event) => {
    if (event.pointerId === pointer) voice.cancel();
  });
  root.addEventListener('keydown', (event) => {
    if (!event.target.closest('[data-ask-mic]') || ![' ', 'Enter'].includes(event.key)) return;
    event.preventDefault();
    if (!event.repeat && startVoice()) heldKey = event.key;
  });
  window.addEventListener('keyup', (event) => {
    if (event.key !== heldKey) return;
    event.preventDefault();
    heldKey = null;
    voice.release();
  });
  root.addEventListener('click', (event) => {
    if (event.target.closest('[data-ask-mic]') && event.detail === 0) {
      // Assistive activation can be a click with no down/up events.
      if (micHeld()) voice.release();
      else startVoice();
    }
    if (event.target.closest('[data-ask-speech]')) {
      speakReplies = !speakReplies;
      if (!speakReplies) stopReading('ask');
      refresh();
    }
  });
  window.addEventListener('blur', () => { if (voiceState !== 'permission') stopVoice(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) stopVoice(); });

  root.addEventListener('keydown', event => {
    if(event.target.id==='sp-chat-input'&&event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();if(!sending)event.target.form.requestSubmit();}
  });
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
    if (prompt && !sending) {
      submitPrompt(prompts[Number(prompt.dataset.askPrompt)]);
      return;
    }
    const note = event.target.closest('[data-ask-note-group]');
    if (note) {
      go('chat');
      void submitMessage('Check whether this group note can authorize an action.', { kind: 'group_note', groupId: note.dataset.askNoteGroup });
      return;
    }
    const settle = event.target.closest('[data-ask-settle-group]');
    if (settle && !settle.disabled) void openSettlement(settle, { groupId: settle.dataset.askSettleGroup, payeeUserId: settle.dataset.askSettleUser });
    const button = event.target.closest('[data-ask-action]');
    if (!button) return;
    const entry = entries.find((value) => String(value.id) === button.dataset.entryId);
    if (!entry || entry.pending) return;
    if (button.dataset.askAction === 'retry' && entry.retryBody) void request(entry, entry.retryBody, entry.retryPath);
    if (button.dataset.askAction === 'reminder-select') {
      const candidate = entry.response.candidates[Number(button.dataset.candidate)];
      if (candidate) void request(entry, { groupId: candidate.groupId, recipientUserId: candidate.recipientUserId,
        expenseId: candidate.expenseId, requestKey: entry.response.requestKey }, '/api/reminders/drafts');
    }
    if (button.dataset.askAction === 'reminder-confirm') void request(entry, {}, `/api/reminders/${encodeURIComponent(entry.response.reminder.id)}/confirm`);
    if (button.dataset.askAction === 'clarification-choice') {
      const choice = entry.response.choices[Number(button.dataset.choice)];
      if (choice) { composerText = choice.message; refresh(); root.querySelector('#sp-chat-input')?.focus(); }
    }
    if (button.dataset.askAction === 'reminder-cancel') {
      entry.response = { type: 'answer', answer: 'Reminder cancelled. No notification was sent and no money moved.' }; entry.retryBody = null; refresh();
    }
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
  function reset({ clearContext = false } = {}) {
    epoch++; for (const controller of controllers) controller.abort(); controllers.clear();
    stopVoice(); speakReplies = false;
    entries.length = 0; composerText = ''; sending = false; panel.clear();
    if (clearContext) {
      topics = [];
      try { sessionStorage.removeItem(contextKey); } catch {}
      rebuildPrompts();
    }
  }
  root.addEventListener('click', (event) => { if (event.target.closest('#sp-logout')) reset({ clearContext: true }); }, true);
  window.addEventListener('pagehide', reset, { once: true });
  void refreshPrompts();
  return { chat, handleAskForm, open() {
    if (!owned()) reset();
    else {
      void refreshPrompts();
      if (state.page === 'chat') root.querySelector('#sp-chat-input')?.focus(); else panel.open();
    }
  }, close(options) { stopVoice(); panel.close(options); }, isOpen: panel.isOpen };
}
