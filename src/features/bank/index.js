import { apiRequest, getSession, logout } from '../../api/session.js';
import { centsToUsdText, usdToCents } from '../../lib/money.js';
import { preserveFocus } from '../../lib/focus.js';
import './styles.css';

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const money = (value) => value === null || value === undefined ? '—' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value / 100);
const statusText = { queued: 'Scheduled to send', submitting: 'Submitting', unknown: 'Verifying with bank', pending: 'Pending', completed: 'Completed', declined: 'Declined', cancelled: 'Cancelled' };

export function mountBank(root) {
  const actorId = getSession()?.actor.userId;
  let data = { accounts: [], presets: [], transactions: [], schedules: [], operations: [] };
  let error = '', busy = false, loading = true, stopped = false, timer, controller, version = 0, activeForm;
  const owned = () => getSession()?.actor.userId === actorId;
  root.innerHTML = `<div class="capital-bank"><header class="bank-header"><a class="bank-brand" href="/bank" aria-label="Capital Two home"><span class="bank-logo" aria-hidden="true"></span>Capital Two<span class="bank-sandbox">Sandbox bank</span></a>
    <nav aria-label="Bank navigation"><a href="/#/overview">Back to Split</a><button type="button" data-bank-action="logout">Log out</button></nav></header>
    <main class="bank-main"><div class="bank-heading"><div><p class="bank-eyebrow">Your money, your rehearsal</p><h1>Hello, ${esc(getSession()?.actor.displayName)}.</h1><p>Make a purchase here. See it in Split.</p></div><button type="button" data-bank-action="refresh">Refresh bank</button></div>
    <div id="bank-status" role="status" aria-live="polite"></div><div id="bank-dashboard"></div></main>
    <dialog class="bank-dialog" aria-labelledby="bank-dialog-title"><div id="bank-dialog-content"></div></dialog></div>`;
  const dashboard = root.querySelector('#bank-dashboard');
  const dialog = root.querySelector('dialog');
  const message = (text, operation = null) => {
    const host = root.querySelector('#bank-status'); host.textContent = text;
    if (operation?.kind === 'purchase' && operation.sharedWithSplit && operation.transactionId && ['pending', 'completed'].includes(operation.status)) {
      const link = root.ownerDocument.createElement('a'); link.textContent = 'View in Split →';
      link.href = `/?split=${encodeURIComponent(operation.transactionId)}#/transactions`; link.className = 'bank-split-now'; host.append(link);
    }
  };
  function showReceipt(operation) {
    const accepted = ['pending', 'completed'].includes(operation.status);
    message(`${operation.payee} · ${money(operation.amountCents)} · ${statusText[operation.status] || 'Verifying with bank'}${accepted && !operation.sharedWithSplit ? ' · Connect this account in Split to share it.' : ''}`, operation);
    if (accepted) {
      const detail = root.ownerDocument.createElement('p'); detail.className = 'bank-receipt-detail';
      detail.textContent = `${operation.category} · ${operation.status === 'pending' ? 'Bank posting pending.' : 'Posted by the bank.'}`;
      root.querySelector('#bank-status').append(detail);
    }
  }
  async function animatePayment(accountId) {
    const card = root.querySelector(`[data-bank-card="${accountId}"]`);
    if (!card || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    card.classList.add('is-swiping');
    // Animation is presentation only; the receipt was already committed.
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 650);
      card.addEventListener('animationend', () => { clearTimeout(timer); resolve(); }, { once: true });
    });
    card.classList.remove('is-swiping');
  }
  function accountOptions(checkingOnly = false) {
    return data.accounts.filter((account) => account.connected && (!checkingOnly || account.kind === 'checking')).map((account) => `<option value="${esc(account.id)}">${esc(account.type)} ••${esc(account.mask || '••••')}</option>`).join('');
  }
  function card(account) {
    const credit = account.type === 'Credit Card';
    return `<article class="bank-card ${credit ? 'bank-card-credit' : ''}" data-bank-card="${esc(account.id)}">
      <div class="bank-card-inner"><div class="bank-card-front"><div class="bank-card-top"><span>Capital Two</span><span>${credit ? 'CREDIT' : 'CHECKING'}</span></div>
        <span class="bank-chip" aria-hidden="true"></span><p class="bank-card-number">•••• &nbsp; •••• &nbsp; •••• &nbsp; ${esc(account.mask || '••••')}</p>
        <p class="bank-card-label">${credit ? 'Amount owed' : 'Available balance'}</p><p class="bank-card-balance">${money(credit ? account.balanceCents : account.availableCents)}</p>
        <p class="bank-card-detail">${credit ? `${money(account.availableCents)} available credit · ${money(account.creditLimitCents)} limit` : `Posted balance ${money(account.balanceCents)}`}</p></div>
      <div class="bank-card-back"><div class="bank-magnetic-strip"></div><p>Made for the practice run.</p><p>Sandbox account · no real card details</p><p>${esc(account.type)} ••${esc(account.mask || '••••')}</p></div></div>
      <button type="button" class="bank-flip" data-bank-flip="${esc(account.id)}" aria-pressed="false" aria-label="Flip ${esc(account.type)} card">Flip card ↻</button></article>`;
  }
  function render() {
    if (stopped || !owned()) return;
    preserveFocus(dashboard, () => {
      const connected = data.accounts.filter((account) => account.connected);
      const credit = connected.find((account) => account.type === 'Credit Card');
      dashboard.innerHTML = `${error ? `<p class="bank-error" role="alert">${esc(error)}</p>` : ''}${loading ? '<p role="status">Refreshing your bank…</p>' : ''}
        <h2 class="bank-section-title">Cards</h2><section class="bank-accounts" aria-label="Your accounts">${connected.map(card).join('')}
        ${!credit ? `<div class="bank-connect"><h2>Your bank, ready to try.</h2><p>Open checking and a Capital Two credit card with a $2,000 sandbox limit. Share them through Split's Connect screen when you choose.</p><button type="button" data-bank-action="connect" ${busy ? 'disabled' : ''}>${connected.length ? 'Open credit card' : 'Open your bank'}</button></div>` : ''}</section>
        <div class="bank-columns"><section class="bank-panel"><h2>Pay &amp; buy</h2><p>Pick a merchant, enter your amount, then choose a card.</p><div class="bank-presets">${data.presets.map((preset, index) => `<button type="button" data-bank-preset="${index}" ${busy || !connected.length ? 'disabled' : ''}><strong>${esc(preset.payee)}</strong><span>${esc(preset.category)}</span></button>`).join('')}</div>
          <div class="bank-actions"><button type="button" data-bank-action="purchase" ${!connected.length ? 'disabled' : ''}>Custom purchase</button><button type="button" data-bank-action="withdrawal" ${!connected.length ? 'disabled' : ''}>Withdraw cash</button></div></section>
        <section class="bank-panel"><h2>Payments</h2><p>Pay a business now, schedule it for later, or repeat it monthly.</p><div class="bank-payment-options">
          <button type="button" data-bank-action="payment" ${!connected.length ? 'disabled' : ''}>One-time payment <span>Now or on a date →</span></button>
          <button type="button" data-bank-action="recurring" ${!connected.length ? 'disabled' : ''}>Recurring payment <span>A fixed amount each month →</span></button>
          <button type="button" data-bank-action="card_payment" ${!credit || !credit.balanceCents || credit.balanceCents < 0 ? 'disabled' : ''}>Pay card balance <span>${money(credit?.balanceCents)} owed →</span></button></div></section></div>
        <section class="bank-panel"><h2>Scheduled</h2><div class="bank-actions"><button type="button" data-bank-action="salary">Set up direct deposit</button></div><p class="bank-note">Direct deposit credits your checking account. Card autopay is not enabled; use Pay card balance for a manual repayment.</p><p class="bank-note">Payments use America/New_York time. Days 29–31 use the last day of shorter months. Run now pays each current occurrence once. Pausing stops future unsent payments.</p>
          ${data.schedules.length ? `<ul class="bank-list">${data.schedules.map((schedule) => `<li><div><strong>${esc(schedule.payee)}</strong><p>${money(schedule.amountCents)} · ${schedule.kind === 'salary' ? `Salary · ${schedule.frequency === 'biweekly' ? 'Every two weeks' : 'Monthly'}` : schedule.dayOfMonth ? `Recurring · Monthly, day ${schedule.dayOfMonth}` : 'One time'} · ${esc(schedule.status)}</p><p>Next date ${esc(schedule.nextDueOn)}</p></div><div class="bank-row-actions">
          ${schedule.status === 'active' ? `<button type="button" data-bank-schedule="${esc(schedule.id)}" data-bank-command="run" ${busy ? 'disabled' : ''}>Run now</button><button type="button" data-bank-schedule="${esc(schedule.id)}" data-bank-command="pause" ${busy ? 'disabled' : ''}>Pause</button>` : schedule.status === 'paused' ? `<button type="button" data-bank-schedule="${esc(schedule.id)}" data-bank-command="resume" ${busy ? 'disabled' : ''}>Resume</button>` : ''}
          <button type="button" data-bank-schedule="${esc(schedule.id)}" data-bank-command="delete" ${busy ? 'disabled' : ''}>Delete</button></div></li>`).join('')}</ul>` : '<p>No scheduled payments yet.</p>'}</section>
        <div class="bank-columns"><section class="bank-panel"><h2>Activity</h2><ul class="bank-list">${data.operations.map((operation) => `<li><div><strong>${esc(operation.payee)}</strong>${operation.kind === 'deposit' ? ' <span class="bank-badge">Salary</span>' : operation.scheduleId ? ' <span class="bank-badge">Scheduled</span>' : ''}<p>${esc(statusText[operation.status] || operation.status)}${operation.status === 'unknown' ? ' · No automatic resend' : ''}</p></div><strong>${money(operation.amountCents)}</strong></li>`).join('') || '<li>Your next payment starts here.</li>'}</ul></section>
        <section class="bank-panel"><h2>Recent transactions</h2><ul class="bank-list">${data.transactions.map((transaction) => `<li><div><strong>${esc(transaction.merchant || transaction.description || transaction.kind)}</strong>${transaction.isSalary ? ' <span class="bank-badge">Salary</span>' : transaction.isRecurring ? ' <span class="bank-badge">Recurring</span>' : ''}<p>${esc(transaction.category || 'Other')} · ${esc(transaction.status)} · ${esc(new Date(transaction.occurredAt).toLocaleString())}</p></div><strong>${transaction.direction === 'credit' ? '+' : '−'}${money(transaction.amountCents)}</strong></li>`).join('') || '<li>No bank transactions yet.</li>'}</ul></section></div>`;
    });
  }
  function stop() {
    stopped = true; version++; clearTimeout(timer); controller?.abort();
    data = { accounts: [], presets: [], transactions: [], schedules: [], operations: [] };
    activeForm = null; dialog.close(); dashboard.replaceChildren();
  }
  async function refresh(sync = true) {
    if (stopped || document.hidden || !owned()) return;
    clearTimeout(timer);
    controller?.abort(); const request = new AbortController(); controller = request;
    const token = ++version; loading = true; error = ''; render();
    try {
      const next = await apiRequest(sync ? '/api/bank/sync' : '/api/bank', { method: sync ? 'POST' : 'GET',
        ...(sync ? { body: {} } : {}), signal: request.signal, timeoutMs: 30_000 });
      if (token !== version || stopped || !owned()) return;
      data = next;
    } catch (failure) {
      if (request.signal.aborted || token !== version) return;
      if (failure.status === 401 || !owned()) { stop(); return; }
      error = 'Bank refresh failed. Your last saved balances are shown. Try Refresh bank.';
    } finally {
      if (token === version && !stopped) {
        loading = false; controller = null; render();
        if (!document.hidden) timer = setTimeout(() => void refresh(), 20_000);
      }
    }
  }
  function openForm(kind, preset = {}) {
    if (busy) return;
    const recurring = kind === 'recurring', payment = kind === 'payment', salary = kind === 'salary';
    const credit = data.accounts.find((account) => account.type === 'Credit Card');
    activeForm = { kind, requestKey: crypto.randomUUID(), signature: '' };
    const categories = data.categories || [];
    root.querySelector('#bank-dialog-content').innerHTML = `<div class="bank-dialog-heading"><h2 id="bank-dialog-title">${({ salary: 'Set up direct deposit', recurring: 'New recurring payment', payment: 'One-time payment', card_payment: 'Pay card balance', withdrawal: 'Withdraw cash', purchase: preset.payee || 'Custom purchase' })[kind]}</h2><button type="button" data-bank-action="close" aria-label="Close payment form">×</button></div>
      <form id="bank-payment-form">
      ${['card_payment', 'withdrawal'].includes(kind) ? '' : `<label>${salary ? 'Employer' : 'Merchant / business'}<input name="payee" required maxlength="80" value="${esc(preset.payee)}" autocomplete="off"></label>`}
      <label>Amount (USD)<input name="amount" inputmode="decimal" required pattern="[0-9]+(\\.[0-9]{1,2})?" value="${kind === 'card_payment' && credit?.balanceCents > 0 ? centsToUsdText(credit.balanceCents) : ''}" placeholder="Enter your amount"></label>
      ${salary || ['card_payment', 'withdrawal'].includes(kind) ? '' : `<label>Category<select name="category" required><option value="">Choose a category</option>${categories.map((category) => `<option ${category === preset.category ? 'selected' : ''}>${esc(category)}</option>`).join('')}</select></label>`}
      <label>${salary ? 'Deposit into' : 'Pay from'}<select name="accountId" required>${accountOptions(salary || kind === 'card_payment')}</select></label>
      ${salary ? '<label>Frequency<select name="frequency"><option value="biweekly">Every two weeks</option><option value="monthly">Monthly</option></select></label><label>Next deposit date<input name="dueOn" type="date" required></label>' : ''}
      ${payment ? '<label>When<select name="timing"><option value="now">Pay now</option><option value="date">On a date</option></select></label><label data-bank-date hidden>Payment date<input name="dueOn" type="date"></label>' : ''}
      ${recurring ? '<label>Day of month<input name="dayOfMonth" type="number" min="1" max="31" required value="1"></label>' : ''}
      <p class="bank-form-error" role="alert"></p><button type="submit">${salary ? 'Save direct deposit' : recurring ? 'Save recurring payment' : 'Pay'}</button></form>`;
    dialog.showModal();
  }
  async function submit(form) {
    if (busy || !activeForm || !owned()) return;
    const values = new FormData(form), current = activeForm;
    let body, path;
    try {
      const amountCents = usdToCents(String(values.get('amount')));
      if (amountCents > 100_000_000) throw new Error('Enter an amount up to $1,000,000.');
      body = { accountId: values.get('accountId'), payee: values.get('payee') || undefined, amountCents, ...(values.get('category') ? { category: values.get('category') } : {}) };
      if (current.kind === 'salary' || current.kind === 'recurring' || (current.kind === 'payment' && values.get('timing') === 'date')) {
        path = '/api/bank/schedules';
        if (current.kind === 'salary') { body.kind = 'salary'; body.frequency = values.get('frequency'); body.dueOn = values.get('dueOn'); }
        else if (current.kind === 'recurring') body.dayOfMonth = Number(values.get('dayOfMonth'));
        else body.dueOn = values.get('dueOn');
      } else { path = '/api/bank/operations'; body.kind = current.kind === 'payment' ? 'purchase' : current.kind; }
      const signature = JSON.stringify({ path, body });
      if (current.signature && signature !== current.signature) current.requestKey = crypto.randomUUID();
      current.signature = signature; body.requestKey = current.requestKey;
    } catch (failure) { form.querySelector('[role="alert"]').textContent = failure.message; return; }
    busy = true; form.querySelector('button[type="submit"]').disabled = true; form.querySelector('[role="alert"]').textContent = '';
    try {
      const result = await apiRequest(path, { method: 'POST', body, timeoutMs: 30_000 });
      if (!owned() || stopped) return;
      const status = result.operation?.status;
      if (['declined', 'cancelled'].includes(status)) {
        form.querySelector('[role="alert"]').textContent = 'The bank declined or cancelled this payment. Check your balance and details. Editing starts a new payment.';
      } else {
        dialog.close(); activeForm = null;
        if (result.schedule) message('Schedule saved. Use Run now to run its current occurrence once.');
        else {
          await animatePayment(body.accountId);
          if (!owned() || stopped) return;
          showReceipt(result.operation);
        }
      }
      void refresh();
    } catch (failure) {
      if (!owned()) { stop(); return; }
      if (form.isConnected) form.querySelector('[role="alert"]').textContent = 'Could not confirm the outcome. Retry these same details to recover this payment safely.';
    } finally {
      busy = false; if (form.isConnected) form.querySelector('button[type="submit"]').disabled = false;
    }
  }
  root.addEventListener('submit', (event) => {
    if (event.target.id !== 'bank-payment-form') return;
    event.preventDefault(); if (event.target.reportValidity()) void submit(event.target);
  });
  root.addEventListener('change', (event) => {
    if (event.target.name === 'timing') {
      const dated = event.target.value === 'date', label = dialog.querySelector('[data-bank-date]');
      label.hidden = !dated; label.querySelector('input').required = dated;
    }
  });
  root.addEventListener('click', async (event) => {
    const button = event.target.closest('button'); if (!button) return;
    if (button.dataset.bankAction === 'logout') { stop(); await logout(); return; }
    if (button.dataset.bankAction === 'close') { if (!busy) dialog.close(); return; }
    if (busy) return;
    if (button.dataset.bankFlip) {
      const card = button.closest('[data-bank-card]'); card.classList.toggle('is-flipped');
      button.setAttribute('aria-pressed', String(card.classList.contains('is-flipped'))); return;
    }
    if (button.dataset.bankPreset != null) { openForm('purchase', data.presets[Number(button.dataset.bankPreset)]); return; }
    const action = button.dataset.bankAction;
    if (action === 'refresh') { void refresh(); return; }
    if (['purchase', 'payment', 'recurring', 'salary', 'card_payment', 'withdrawal'].includes(action)) { openForm(action); return; }
    if (action === 'connect' || button.dataset.bankSchedule) {
      busy = true; button.disabled = true; error = '';
      try {
        let result;
        if (action === 'connect') result = await apiRequest('/api/bank/connect', { method: 'POST', body: {}, timeoutMs: 60_000 });
        else {
          const command = button.dataset.bankCommand, path = `/api/bank/schedules/${encodeURIComponent(button.dataset.bankSchedule)}`;
          result = await apiRequest(`${path}${command === 'run' ? '/run' : ''}`, { method: 'POST', body: command === 'run' ? {} : { action: command }, timeoutMs: 30_000 });
          if (result.operation && owned() && !stopped) showReceipt(result.operation);
          else message('Payment schedule updated.');
        }
        if (!owned() || stopped) return;
        if (action === 'connect') { data = result; message('Your bank is ready.'); }
        else void refresh();
      } catch (failure) { if (owned() && !stopped) { error = failure.message || 'This bank action could not be completed. Try again.'; message(error); } }
      finally { busy = false; render(); }
    }
  });
  dialog.addEventListener('cancel', (event) => { if (busy) event.preventDefault(); });
  document.addEventListener('visibilitychange', () => {
    clearTimeout(timer); version++; controller?.abort(); if (!document.hidden) void refresh();
  });
  let frame;
  root.addEventListener('pointermove', (event) => {
    const card = event.target.closest('[data-bank-card]');
    if (!card || matchMedia('(prefers-reduced-motion: reduce)').matches || !matchMedia('(hover: hover)').matches) return;
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      const box = card.getBoundingClientRect();
      card.style.setProperty('--tilt-x', `${((event.clientY - box.top) / box.height - .5) * -8}deg`);
      card.style.setProperty('--tilt-y', `${((event.clientX - box.left) / box.width - .5) * 8}deg`);
    });
  });
  root.addEventListener('pointerout', (event) => {
    const card = event.target.closest('[data-bank-card]');
    if (card && !card.contains(event.relatedTarget)) { cancelAnimationFrame(frame); card.style.removeProperty('--tilt-x'); card.style.removeProperty('--tilt-y'); }
  });
  window.addEventListener('pagehide', stop, { once: true });
  render(); void refresh();
}
