import { canReadAloud, readAloud } from '../../lib/read-aloud.js';
import { apiRequest, getSession } from '../../api/session.js';
import { financialChanged, financialRevision, subscribeFinancialChanges } from '../../api/financial-state.js';
import { usdToCents } from '../../lib/money.js';
import {
  calendarOption,
  cashFlowOption,
  categoryOption,
  chartHost,
  createChartManager,
  goalOption,
  recurringOption,
  sankeyOption,
} from '../insights/charts.js';

// B5 · Overview and Profile, driven by GET /api/overview and
// POST /api/banking/sync. Every number on these two pages comes from the API;
// pages render from a small cache and refetch when the range changes.
// B6 · Add an expense from Overview through A's draft/confirm routes and A5's
// shared ticket, and show C4's GET /api/insight for the same month window.

const TIME_ZONE = 'America/New_York';
const PERIODS = { month: null, quarter: 2, half: 5 }; // months back from this one
const CATEGORY_ICONS = {
  'Food & drink': 'utensils',
  Groceries: 'shopping-basket',
  'Home & bills': 'house',
  'Getting around': 'train-front',
  'Just for fun': 'ticket',
  Income: 'arrow-down-left',
  Other: 'receipt',
};
const METHOD_ICONS = [
  ['Bank transfer', 'landmark'],
  ['Debit card', 'credit-card'],
  ['Credit card', 'credit-card'],
  ['Card', 'credit-card'],
  ['Contactless', 'nfc'],
  ['Cash', 'banknote'],
];
const CATEGORIES = ['Food & drink', 'Home & bills', 'Getting around', 'Just for fun', 'Other'];

const todayLocal = () => new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE }).format(new Date());
const asDate = (day) => new Date(`${day}T12:00:00Z`);
const fmtDay = (day, opts) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', ...opts }).format(asDate(day));
const addDays = (day, n) => {
  const d = asDate(day);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const lastOfMonth = (day) => {
  const d = asDate(day);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
};

export function rangeFor(period, today = todayLocal()) {
  const back = PERIODS[period];
  if (back === null || back === undefined) return { from: `${today.slice(0, 8)}01`, to: today, bucket: 'day' };
  const [y, m] = today.split('-').map(Number);
  const from = new Date(Date.UTC(y, m - 1 - back, 1)).toISOString().slice(0, 10);
  return { from, to: today, bucket: 'month' };
}

export function createOverview({ root, view, state, icon, money, dollarLabel, esc, heading, render, persist, announce, openModal, closeModal, closeButton, toast, draftTicket, registerReview }) {
  state.profileTab = state.profileTab || 'spending';
  state.period = PERIODS[state.period] !== undefined ? state.period : 'month';
  state.category = state.category || 'all';
  state.merchantSort = state.merchantSort || 'spend';
  let echartSpecs = new Map();
  const chartManager = createChartManager(root);

  // ── Data ──────────────────────────────────────────────────────────────
  const store = {
    data: {}, // period → overview response
    inflight: {},
    errors: {},
    syncing: false,
    synced: false,
    syncError: null,
    lastSync: null,
    connecting: false,
    connectError: null,
    lastSyncAt: null,
    seenTx: null, // transaction ids already shown (B12 "New" badges)
    newTx: new Map(), // id → first seen (ms)
  };
  const transactionFeed = { account: '', category: '', unsplit: false, categories: [], rows: null, nextOffset: null, error: null, request: null };
  const selectedTransactions = new Map();
  const analytics = { data: null, error: null, request: null, revision: -1 };

  async function loadAnalytics() {
    const revision = financialRevision();
    const request = apiRequest('/api/insights');
    analytics.request = request;
    analytics.error = null;
    try {
      const data = await request;
      if (analytics.request === request && revision === financialRevision()) {
        Object.assign(analytics, { data, revision });
      }
    } catch (error) {
      if (analytics.request === request && revision === financialRevision()) analytics.error = error;
    } finally {
      if (analytics.request === request) {
        analytics.request = null;
        refresh();
      }
    }
  }

  function needAnalytics() {
    const current = analytics.revision === financialRevision();
    if (!current && !analytics.request && !analytics.error) void loadAnalytics();
    return current ? analytics.data : null;
  }

  function resetTransactionFeed() {
    Object.assign(transactionFeed, { rows: null, nextOffset: null, error: null, request: null });
  }

  async function loadTransactions(offset = 0) {
    const feed = transactionFeed;
    const query = new URLSearchParams({ account: feed.account, category: feed.category, unsplit: feed.unsplit, offset });
    const request = apiRequest(`/api/banking/transactions?${query}`);
    feed.request = request;
    feed.error = null;
    try {
      const { transactions, nextOffset, categories, categoryChoices } = await request;
      if (feed.request !== request) return;
      feed.rows = offset ? [...new Map([...feed.rows, ...transactions].map((row) => [row.id, row])).values()] : transactions;
      feed.nextOffset = nextOffset;
      feed.categories = categories;
      feed.categoryChoices = categoryChoices ?? [];
      for (const row of transactions) {
        if (row.splitGroupName || !splittable(row)) selectedTransactions.delete(row.id);
      }
    } catch (error) {
      if (feed.request === request) feed.error = error;
    } finally {
      if (feed.request === request) {
        feed.request = null;
        refresh();
      }
    }
  }

  const NEW_BADGE_MS = 90_000;
  const AUTO_SYNC_MS = 20_000;
  const visible = () => ['home', 'profile', 'transactions'].includes(state.page);
  const refresh = () => {
    if (visible() && !root.querySelector('#sp-modal-root').children.length) render();
  };

  async function load(period) {
    const revision = financialRevision();
    const r = rangeFor(period);
    store.inflight[period] = true;
    store.errors[period] = null;
    try {
      const data = await apiRequest(
        `/api/overview?from=${r.from}&to=${r.to}&bucket=${r.bucket}`,
      );
      if (revision === financialRevision()) {
        store.data[period] = data;
        if (period === 'month') noteNewTransactions(data.recent);
      }
    } catch (err) {
      store.errors[period] = err;
    } finally {
      store.inflight[period] = false;
      refresh();
    }
  }

  // Shared groups (A1) for "In it together" and the Add Expense group picker.
  const groupStore = { list: null, error: null, inflight: false };
  async function loadGroups() {
    const revision = financialRevision();
    groupStore.inflight = true;
    groupStore.error = null;
    try {
      const { groups } = await apiRequest('/api/groups');
      if (revision === financialRevision()) groupStore.list = groups;
    } catch (err) {
      groupStore.error = err;
    } finally {
      groupStore.inflight = false;
      refresh();
    }
  }
  function needGroups() {
    if (!groupStore.list && !groupStore.inflight && !groupStore.error) loadGroups();
    return groupStore.list;
  }

  // C4's insight for this month. It is requested only after the bank sync has
  // settled, and is tied to the financial revision it was computed from, so a
  // confirmed expense, goal move, settlement or sync always triggers a new one.
  const insight = { data: null, error: null, inflight: false, revision: -1 };
  async function loadInsight() {
    const revision = financialRevision();
    const r = rangeFor('month');
    insight.inflight = true;
    insight.error = null;
    try {
      const data = await apiRequest(`/api/insight?from=${r.from}&to=${r.to}&bucket=${r.bucket}`, { timeoutMs: 30_000 });
      if (revision === financialRevision()) Object.assign(insight, { data, revision });
    } catch (err) {
      if (revision === financialRevision()) Object.assign(insight, { error: err, revision });
    } finally {
      insight.inflight = false;
      refresh();
    }
  }
  function needInsight() {
    const current = insight.revision === financialRevision();
    if (store.synced && !store.syncing && !current && !insight.inflight) loadInsight();
    return current ? insight.data : null;
  }

  function noteNewTransactions(recent) {
    const ids = recent.map((t) => t.id);
    if (store.seenTx) for (const id of ids) if (!store.seenTx.has(id)) store.newTx.set(id, Date.now());
    store.seenTx = new Set([...(store.seenTx ?? []), ...ids]);
  }
  const isNew = (t) => (store.newTx.get(t.id) ?? 0) > Date.now() - NEW_BADGE_MS;

  subscribeFinancialChanges(() => {
    store.data = {};
    store.errors = {};
    resetTransactionFeed();
    groupStore.list = null;
    groupStore.error = null;
    insight.data = null;
    insight.error = null;
    Object.assign(analytics, { data: null, error: null, request: null, revision: -1 });
    refresh();
  });

  /** Cached overview for a period; starts a fetch (once) when missing. */
  function need(period) {
    if (!store.synced && !store.syncing) {
      sync({ quiet: true });
      return store.data[period] ?? null;
    }
    if (store.syncing && !store.data[period]) return null;
    if (!store.data[period] && !store.inflight[period] && !store.errors[period]) load(period);
    return store.data[period] ?? null;
  }

  // B12 · Sync with Capital Two on load, on Refresh, when the tab regains
  // focus, and every 20 s while Overview, Transactions or Insights is open.
  // Views only reload when the sync actually found something.
  async function sync({ quiet = false, auto = false } = {}) {
    if (store.syncing || store.connecting) return;
    const hadError = Boolean(store.syncError);
    store.syncing = true;
    store.syncError = null;
    if (!auto) refresh();
    else updateSyncChip();
    let rerender = !auto || hadError;
    try {
      const result = await apiRequest('/api/banking/sync', { method: 'POST', body: {} });
      const moved = result.latestActivityAt !== store.lastActivityAt;
      store.lastActivityAt = result.latestActivityAt;
      store.lastSync = result;
      store.lastSyncAt = Date.now();
      if (moved && !result.changed && store.synced) {
        // Activity arrived outside this sync (Capital Two wrote it directly).
        resetTransactionFeed();
        financialChanged();
      }
      if (result.changed || moved || !auto) {
        resetTransactionFeed();
        store.data = {};
        store.errors = {};
        rerender = true;
      }
      if (result.changed) financialChanged();
      if (!quiet) {
        const n = result.imported;
        toast(n ? `${n} new ${n === 1 ? 'transaction' : 'transactions'} from Capital Two.` : 'You’re up to date with Capital Two.');
      }
    } catch (err) {
      store.syncError = err;
      rerender = rerender || !hadError;
      if (!quiet) announce('We couldn’t reach Capital Two. Showing your saved activity.');
    } finally {
      store.syncing = false;
      store.synced = true;
      if (rerender) refresh();
      else updateSyncChip();
    }
  }

  const modalOpen = () => Boolean(root.querySelector('#sp-modal-root').children.length);
  function autoSync() {
    if (document.visibilityState !== 'visible' || !visible() || !store.synced || needsBank() || modalOpen()) return;
    if (Date.now() - (store.lastSyncAt ?? 0) < 5_000) return;
    void sync({ quiet: true, auto: true });
  }
  setInterval(autoSync, AUTO_SYNC_MS);
  document.addEventListener('visibilitychange', autoSync);
  window.addEventListener('focus', autoSync);

  // B9/B12 · Capital Two accounts are shared with Split only after the user
  // allows it on the Connect screen. Without a linked account, Overview shows
  // a Connect card in place of the sync chip.
  const needsBank = () => store.syncError?.code === 'NO_LINKED_ACCOUNT';
  let consentAsked = false;

  function connectCard() {
    return `<div class="data-state" role="status" data-bank-connect>${icon('landmark')}<div><strong>Connect Capital Two</strong><p class="small muted">Share your Capital Two checking account and credit card with Split to see your balance and split purchases with your groups.</p><button type="button" class="primary cursor-interaction" data-action="bank-manage">${icon('landmark')}Connect Capital Two</button></div></div>`;
  }

  function accountLine(a) {
    const label = a.kind === 'credit_card' ? 'Credit card' : 'Checking';
    const number = a.mask ? ` ••${esc(a.mask)}` : '';
    const detail = !a.opened
      ? 'Opens when you allow'
      : a.kind === 'credit_card'
        ? `${money(a.creditLimitCents ?? 0)} limit`
        : money(a.balanceCents ?? 0);
    return `<li class="consent-account">${icon(a.kind === 'credit_card' ? 'credit-card' : 'landmark')}<span><strong>${label}${number}</strong><span class="small muted">${detail}</span></span><span class="tag">${a.linked ? 'Shared' : 'Not shared'}</span></li>`;
  }

  /** The Connect screen (B12): sign-up, the Connect card and the account menu. */
  async function openBankConnect({ auto = false } = {}) {
    let listing;
    try {
      listing = await apiRequest('/api/banking/accounts');
    } catch (err) {
      if (!auto) toast(err.message);
      return;
    }
    if (auto && (!listing.needsConsent || modalOpen())) return;
    const accounts = listing.accounts.length
      ? listing.accounts
      : [{ kind: 'checking', opened: false, linked: false }, { kind: 'credit_card', opened: false, linked: false }];
    if (!accounts.some((a) => a.kind === 'credit_card')) accounts.push({ kind: 'credit_card', opened: false, linked: false });
    const body = listing.needsConsent
      ? `<p>Capital Two wants to share these accounts with Split:</p><ul class="consent-list">${accounts.map(accountLine).join('')}</ul><div class="checks"><div class="check-row">${icon('check')}Split can see balances and transactions.</div><div class="check-row">${icon('shield-check')}Split can’t move money without your approval.</div></div><p class="error" role="alert" data-connect-error></p><div class="modal-actions"><button type="button" class="secondary cursor-interaction" data-action="close">Not now</button><button type="button" class="primary cursor-interaction" data-action="bank-allow">Allow</button></div>`
      : `<p>These Capital Two accounts are shared with Split and sync automatically.</p><ul class="consent-list">${accounts.map(accountLine).join('')}</ul><div class="modal-actions"><button type="button" class="secondary cursor-interaction" data-action="bank-sync-now">Sync now</button><button type="button" class="primary cursor-interaction" data-action="close">Done</button></div>`;
    openModal('Connect Capital Two', `<div class="modal-header"><div><div class="eyebrow">Capital Two</div><h2>${listing.needsConsent ? 'Share your accounts with Split?' : 'Connected to Split'}</h2></div>${closeButton}</div>${body}`);
  }

  function maybeAskConsent() {
    if (consentAsked) return;
    consentAsked = true;
    setTimeout(() => void openBankConnect({ auto: true }), 300);
  }

  async function connectBank(button) {
    if (store.connecting) return;
    store.connecting = true;
    store.connectError = null;
    const errorHost = root.querySelector('[data-connect-error]');
    if (button) {
      button.disabled = true;
      button.textContent = 'Connecting…';
    }
    try {
      const result = await apiRequest('/api/banking/connect', { method: 'POST', body: {}, timeoutMs: 60_000 });
      store.syncError = null;
      store.synced = true;
      store.lastSync = result;
      store.lastSyncAt = Date.now();
      store.data = {};
      store.errors = {};
      if (button?.isConnected) closeModal();
      financialChanged();
      const masks = result.accounts.filter((a) => a.linked && a.mask).map((a) => `${a.kind === 'credit_card' ? 'card' : 'checking'} ••${a.mask}`);
      toast(`Capital Two connected${masks.length ? `: ${masks.join(' and ')}` : ''}.`);
    } catch (err) {
      store.connectError = err;
      if (errorHost?.isConnected) errorHost.textContent = err.message;
      announce(err.message);
      if (button?.isConnected) {
        button.disabled = false;
        button.textContent = 'Try again';
      }
    } finally {
      store.connecting = false;
      refresh();
    }
  }

  function relativeTime(ms) {
    if (!ms) return null;
    const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (seconds < 60) return 'just now';
    if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
    return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', month: 'short', day: 'numeric' }).format(new Date(ms));
  }

  function syncText(d) {
    if (store.syncing) return 'Syncing with Capital Two…';
    if (store.syncError) return 'Couldn’t reach Capital Two · showing saved numbers';
    const asOf = store.lastSyncAt ?? (d?.account?.balanceAsOf ? new Date(d.account.balanceAsOf).getTime() : null);
    return asOf ? `Synced with Capital Two · ${relativeTime(asOf)}` : 'Not synced with Capital Two yet';
  }

  function syncBar(d) {
    if (needsBank()) {
      maybeAskConsent();
      return connectCard();
    }
    return `<div class="sync-chip${store.syncError ? ' is-error' : ''}${store.syncing ? ' is-syncing' : ''}" data-sync-chip><span class="sync-dot" aria-hidden="true"></span><span class="sync-text" role="status">${esc(syncText(d))}</span><button type="button" class="sync-now cursor-interaction" data-action="bank-sync" aria-label="Sync with Capital Two now" ${store.syncing ? 'disabled aria-busy="true"' : ''}>${icon('rotate-ccw')}</button></div>`;
  }

  /** Refresh the chip text in place (no full re-render when nothing changed). */
  function updateSyncChip() {
    const chip = root.querySelector('[data-sync-chip]');
    if (!chip) return;
    chip.classList.toggle('is-syncing', store.syncing);
    chip.classList.toggle('is-error', Boolean(store.syncError));
    chip.querySelector('.sync-text').textContent = syncText(store.data.month ?? Object.values(store.data)[0]);
    const button = chip.querySelector('[data-action="bank-sync"]');
    button.disabled = store.syncing;
  }

  function loadingCard() {
    return `<div class="data-state" role="status">${icon('landmark')}<div><strong>Getting your numbers</strong><p class="small muted">Reading your account and recent activity…</p></div></div>`;
  }

  function errorCard(period) {
    const err = store.errors[period];
    if (err?.code === 'NO_LINKED_ACCOUNT') {
      maybeAskConsent();
      return needsBank() ? '' : connectCard();
    }
    const msg = err?.code === 'NO_LINKED_ACCOUNT'
      ? 'Your demo bank account isn’t connected yet.'
      : err?.message || 'Something went wrong loading your numbers.';
    return `<div class="data-state is-error" role="alert">${icon('info')}<div><strong>We couldn’t load this view</strong><p class="small muted">${esc(msg)}</p><button type="button" class="secondary cursor-interaction" data-action="overview-retry" data-period="${period}">${icon('rotate-ccw')}Try again</button></div></div>`;
  }

  // ── Chart data ────────────────────────────────────────────────────────
  function bucketLabel(b, bucket) {
    if (bucket === 'day') return fmtDay(b.start, { month: 'short', day: 'numeric' });
    const month = fmtDay(b.start, { month: 'short' });
    const partial = b.start.slice(8) !== '01' || b.end !== lastOfMonth(b.start);
    return partial ? `${month} ${Number(b.start.slice(8))}–${Number(b.end.slice(8))}` : month;
  }

  /** Points for the chart: cumulative per day, or per-month totals. */
  function series(d) {
    if (!d) return [];
    const bucket = d.range.bucket;
    let earned = 0,
      spent = 0;
    const points = d.buckets.map((b) =>
      bucket === 'day'
        ? { label: bucketLabel(b, bucket), earned: (earned += b.earnedCents), spent: (spent += b.spentCents) }
        : { label: bucketLabel(b, bucket), earned: b.earnedCents, spent: b.spentCents },
    );
    return points.length === 1 ? [points[0], { ...points[0] }] : points;
  }

  function moneyChart(id, data, mode = 'profile') {
    const monthly = data.map((point, index) => ({
      month: point.month ?? String(index),
      label: point.label,
      earnedCents: point.earned,
      spentCents: point.spent,
      netCents: point.earned - point.spent,
    }));
    echartSpecs.set(id, cashFlowOption(monthly, { zoom: mode !== 'home' }));
    return chartHost(id, 'Interactive income, spending and net chart', mode === 'home' ? 'echart-home' : 'echart-flow');
  }

  function chartControls() {
    return '';
  }

  // ── Shared bits ───────────────────────────────────────────────────────
  function tx(name, sub, amount, symbol, trailing = '') {
    return `<div class="transaction"><span class="tx-icon">${icon(symbol)}</span><div class="tx-copy"><strong>${name}</strong><span>${sub}</span></div><span class="tx-amount money">${amount}</span>${trailing}</div>`;
  }

  // Purchases can be split with a group (A2/A3 bank link); split ones say where.
  const splittable = (t) => t.kind === 'purchase' && t.direction === 'debit' && t.providerKey &&
    ['pending', 'completed'].includes(t.status);
  function txActions(t) {
    if (t.splitGroupName) {
      const owed = t.splitOwedCents > 0 ? ` · you’re owed ${money(t.splitOwedCents)}` : '';
      return `<span class="tx-split-tag">${icon('users')}Split with ${esc(t.splitGroupName)}${owed}</span>${state.page === 'transactions'
        ? `<button type="button" class="text-button" data-recurring-action="create" data-transaction="${esc(t.id)}">Repeat this split</button>` : ''}`;
    }
    if (!splittable(t)) return '<span class="tx-split-tag is-empty" aria-hidden="true"></span>';
    return `<button type="button" class="tx-split cursor-interaction" data-action="split-tx" data-tx-id="${esc(t.id)}" aria-label="Split ${esc(t.merchantName || t.description)}, ${money(t.amountCents)}">Split</button>`;
  }

  function dayWord(day, today) {
    if (day === today) return 'Today';
    if (day === addDays(today, -1)) return 'Yesterday';
    return fmtDay(day, { month: 'short', day: 'numeric' });
  }

  function txRow(t, today, selectable = false) {
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE }).format(new Date(t.occurredAt));
    const settled = t.settledWithSplit ? t.settled : null;
    const label = t.salary ? 'Salary' : settled ? t.category || 'Other' : t.kind === 'transfer' ? 'Transfer' : t.kind === 'deposit' ? 'Deposit' : t.category || 'Purchase';
    // On Transactions the category is a button: re-categorize in Split (B15),
    // settlements included (B17: they count in the category they paid for).
    const categoryPart = selectable && (t.kind === 'purchase' || settled)
      ? `<button type="button" class="tx-category" data-tx-category="${esc(t.id)}" aria-label="Change category for ${esc(t.merchantName || t.description)}, now ${esc(label)}">${esc(label)}${t.categoryOverridden ? ' <span class="small muted">· yours</span>' : ''}${icon('chevron-down')}</button>`
      : esc(label);
    const flags = [
      settled?.categories?.length > 1 ? `+ ${settled.categories.slice(1).map((c) => esc(c.category)).join(', ')}` : null,
      settled ? (settled.direction === 'received' ? 'money back' : esc(settled.group)) : null,
      t.accountKind === 'credit_card' ? `card${t.accountMask ? ` ••${esc(t.accountMask)}` : ''}` : null,
      t.status === 'pending' ? 'pending' : null,
      t.source === 'demo' ? 'demo history' : null,
    ].filter(Boolean);
    // B15 · What the bank tells us: salary and recurring payments.
    const badges = [
      t.salary ? `<span class="tx-badge is-salary">${icon('banknote')}Salary</span>` : '',
      t.recurring === 'scheduled' ? `<span class="tx-badge is-recurring" title="Paid by a Capital Two recurring payment${t.recurringPayee ? ` to ${esc(t.recurringPayee)}` : ''}">${icon('repeat-2')}Recurring</span>` : '',
      t.recurring === 'detected' ? `<span class="tx-badge is-detected" title="Same merchant and amount as last month">${icon('repeat-2')}Looks recurring</span>` : '',
      settled ? `<span class="tx-badge is-settled" title="${settled.direction === 'received' ? `${esc(settled.with)} paid you back in ${esc(settled.group)}. It lowers your ${esc(label)} spending.` : `You paid ${esc(settled.with)} back in ${esc(settled.group)}. It counts as ${esc(label)} spending.`}">${icon('heart-handshake')}Settled with Split</span>` : '',
    ].join('');
    const sign = t.direction === 'credit' ? '+ ' : '− ';
    const symbol = settled ? CATEGORY_ICONS[t.category] || 'heart-handshake' : t.kind === 'transfer' ? 'repeat-2' : CATEGORY_ICONS[t.category] || (t.kind === 'deposit' ? 'arrow-down-left' : 'receipt');
    const row = tx(
      `${esc((t.kind === 'deposit' && t.bankPayee) || t.merchantName || t.description)}${(t.recentlyImported ?? isNew(t)) ? ' <span class="tx-new">New</span>' : ''}${badges}`,
      `${dayWord(day, today)} · ${categoryPart}${flags.length ? ` · ${flags.join(' · ')}` : ''}`,
      sign + money(t.amountCents),
      symbol,
      txActions(t),
    );
    if (!selectable) return row;
    const selector = splittable(t) && !t.splitGroupName
      ? `<input type="checkbox" data-select-transaction="${esc(t.id)}" aria-label="Select ${esc(t.merchantName || t.description)}, ${money(t.amountCents)}" ${selectedTransactions.has(t.id) ? 'checked' : ''}>`
      : '';
    const suggestion = t.suggestion ? `<span class="tx-suggestion">Suggested · ${esc(t.suggestion)}</span>` : '';
    return `<div class="tx-select-row"><span>${selector}</span><div>${row}${suggestion}</div></div>`;
  }

  function transactionBatchButton() {
    const count = selectedTransactions.size;
    return `<button type="button" class="primary" data-action="split-selected" ${count ? '' : 'disabled'}>Split selected${count ? ` (${count})` : ''}</button>`;
  }

  function transactions() {
    maybeAskConsent();
    const today = todayLocal();
    const d = need('month');
    const feed = transactionFeed;
    if (store.synced && !feed.rows && !feed.request && !feed.error) void loadTransactions();
    const head = heading('Transactions', 'Your transactions', 'Checking and card activity from Capital Two.');
    const categories = [...new Set([...feed.categories, feed.category].filter(Boolean))];
    const filterSelect = (key, label, options) => `<label class="tx-control tx-select${feed[key] ? ' is-active' : ''}"><span class="sr-only">${label}</span><select data-tx-filter="${key}">${options}</select>${icon('chevron-down')}</label>`;
    const filters = `<div class="sp-card tx-filters">
      <div class="tx-filter-group" role="group" aria-label="Filter transactions">
        ${filterSelect('account', 'Account', `<option value="">All accounts</option><option value="checking" ${feed.account === 'checking' ? 'selected' : ''}>Checking</option><option value="credit_card" ${feed.account === 'credit_card' ? 'selected' : ''}>Credit card</option>`)}
        ${filterSelect('category', 'Category', `<option value="">All categories</option>${categories.map((category) => `<option ${feed.category === category ? 'selected' : ''}>${esc(category)}</option>`).join('')}`)}
        <label class="tx-control tx-toggle${feed.unsplit ? ' is-active' : ''}"><input type="checkbox" data-tx-filter="unsplit" ${feed.unsplit ? 'checked' : ''}>${icon('check')}Not yet split</label>
      </div>
      <div class="tx-filter-actions">
        <button type="button" class="secondary cursor-interaction" data-action="overview-add-expense">${icon('banknote')}Cash expense</button>
        <span data-tx-selection>${transactionBatchButton()}</span>
      </div>
    </div>`;
    const status = feed.error
      ? `<p role="alert">${esc(feed.error.message)} <button type="button" class="secondary" data-action="tx-more">Try again</button></p>`
      : feed.request || !feed.rows
        ? '<p role="status">Loading transactions…</p>'
        : feed.nextOffset !== null
          ? '<button type="button" class="secondary" data-action="tx-more">Load more</button>'
          : '';
    const header = head + syncBar(d) + filters;
    if (!feed.rows?.length) {
      return header + (status || '<div class="sp-empty"><h2>No matching transactions</h2><p>Adjust the filters or refresh Capital Two.</p></div>');
    }
    const days = new Map();
    for (const t of feed.rows) {
      const day = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE }).format(new Date(t.occurredAt));
      if (!days.has(day)) days.set(day, []);
      days.get(day).push(t);
    }
    return header + [...days].map(([day, list]) => {
      const net = list.reduce((sum, t) => sum + (t.direction === 'credit' ? t.amountCents : -t.amountCents), 0);
      const label = day === today ? 'Today' : day === addDays(today, -1) ? 'Yesterday' : fmtDay(day, { weekday: 'short', month: 'short', day: 'numeric' });
      return `<section class="sp-card tx-day" aria-label="${esc(label)}"><div class="tx-day-head"><h2>${esc(label)}</h2><span class="money muted">${net >= 0 ? '+ ' : '− '}${money(Math.abs(net))}</span></div>${list.map((t) => txRow(t, today, true)).join('')}</section>`;
    }).join('') + status;
  }

  /** "••1234 · card ••9876" for the account menu, once Overview has loaded. */
  function bankLabel() {
    const d = Object.values(store.data).find((x) => x?.account);
    if (!d) return null;
    const parts = [d.account.mask ? `••${d.account.mask}` : null, d.cards?.[0]?.mask ? `card ••${d.cards[0].mask}` : null].filter(Boolean);
    return parts.length ? parts.join(' · ') : null;
  }

  const billsWithin = (bills, today, days) =>
    bills.filter((b) => b.nextDueOn >= today && b.nextDueOn <= addDays(today, days - 1));
  const sumCents = (list, key = 'amountCents') => list.reduce((a, b) => a + b[key], 0);

  // ── Overview (home) ───────────────────────────────────────────────────
  // What you spent on most this month (real data; replaces fixed budgets).
  function topCategories(d) {
    const cats = d.breakdown.categories.filter((c) => c.cents > 0).slice(0, 4);
    if (!cats.length) return '<p class="small muted">No spending yet this month.</p>';
    const total = d.totals.spentCents || cats.reduce((a, c) => a + c.cents, 0);
    return cats.map((c) => {
      const pct = total ? Math.round((c.cents / total) * 100) : 0;
      return `<button type="button" class="top-category cursor-interaction" data-category="${esc(c.category)}" aria-label="${esc(c.category)}: ${money(c.cents)}, ${pct} percent of spending. See details"><span class="top-category-icon">${icon(CATEGORY_ICONS[c.category] || 'receipt')}</span><span class="top-category-body"><span class="math-line"><strong>${esc(c.category)}</strong><span class="money">${dollarLabel(c.cents)}</span></span><span class="category-track"><span style="width:${pct}%"></span></span><span class="small muted">${pct}% of spending</span></span></button>`;
    }).join('');
  }

  // B15 · The Capital Two card, drawn like the card itself.
  function cardArt(c, { compact = false } = {}) {
    const limit = c.creditLimitCents ?? 0;
    const owed = c.owedCents;
    const used = owed !== null && limit ? Math.min(100, Math.round((owed / limit) * 100)) : null;
    return `<article class="split-card${compact ? ' is-compact' : ''}" aria-label="Capital Two credit card${c.mask ? ` ending ${esc(c.mask)}` : ''}">
      <div class="split-card-art"><span class="split-card-brand">Capital Two</span><span class="split-card-chip" aria-hidden="true"></span>
        <span class="split-card-number">•••• ${esc(c.mask ?? '••••')}</span><span class="split-card-kind">Credit</span></div>
      <div class="split-card-facts"><div><span class="small muted">Balance owed</span><strong class="money">${owed === null ? '—' : money(owed)}</strong></div>
        <div><span class="small muted">Available</span><strong class="money">${owed === null ? '—' : money(Math.max(0, limit - owed))}</strong></div>
        <div class="split-card-used"><span class="small muted">Credit used${used === null ? '' : ` · ${used}%`}</span><span class="category-track"><span style="width:${used ?? 0}%"></span></span><span class="small muted">of ${money(limit)} limit</span></div></div>
    </article>`;
  }

  function salaryLine(d) {
    const s = d.salary;
    if (!s) return '';
    const today = todayLocal();
    const days = s.nextPaidOn ? Math.round((Date.parse(`${s.nextPaidOn}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86_400_000) : null;
    const first = !s.lastPaidOn;
    const when = s.nextPaidOn && days >= 0
      ? `${first ? 'First' : 'Next'} paycheck ${days === 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`} · ${fmtDay(s.nextPaidOn, { month: 'short', day: 'numeric' })}${s.nextIsScheduled ? '' : ' (estimated)'}`
      : s.lastPaidOn ? `Last paycheck ${fmtDay(s.lastPaidOn, { month: 'short', day: 'numeric' })}` : 'Direct deposit set up';
    return `<div class="salary-line">${icon('banknote')}<span><strong>${esc(when)}</strong><span class="small muted">${s.employer ? `${esc(s.employer)} · ` : ''}${money(s.amountCents)}</span></span></div>`;
  }

  function cardStrip(d) {
    const cards = (d.cards ?? []).map((c) => cardArt(c)).join('');
    const salary = salaryLine(d);
    return cards || salary ? `<div class="money-extras">${cards}${salary}</div>` : '';
  }


  const clock = (iso) =>
    new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, hour: 'numeric', minute: '2-digit' }).format(new Date(iso));

  // C's assistant errors are worded for Ask ("enter the expense manually");
  // the insight card says what happened to the thought instead.
  function insightErrorText(err) {
    if (err.code === 'ASSISTANT_NOT_CONFIGURED') return 'Split AI isn’t set up on this server yet, so there’s no thought to share.';
    if (err.code === 'ASSISTANT_TIMEOUT') return 'Split AI took too long to think this one through.';
    if (/ASSISTANT/.test(err.code ?? '')) return 'Split AI couldn’t put a thought together just now.';
    return esc(err.message);
  }

  function insightCard() {
    const data = needInsight();
    const failed = !data && insight.error && insight.revision === financialRevision();
    const body = data
      ? `<p>${esc(data.answer)}</p>${canReadAloud()
        ? `<button type="button" class="text-button" data-action="insight-read" aria-label="Read summary aloud">${icon('speaker-high')} Read aloud</button>` : ''}<span class="small muted">Worked out at ${clock(data.asOf)} from your balance and this month’s activity.</span>`
      : failed
        ? `<p>${insightErrorText(insight.error)}</p><button type="button" class="cursor-interaction" data-action="insight-retry">Try again</button>`
        : '<p class="muted" role="status">Reading this month’s activity…</p>';
    return `<div class="insight" data-insight aria-busy="${!data && !failed}">${icon('sprout')}<div><div class="insight-label">A thought from Split · AI</div>${body}</div></div>`;
  }

  function groupRows() {
    const groups = needGroups();
    if (!groups) {
      return groupStore.error
        ? `<p class="small muted" role="alert">${esc(groupStore.error.message)} <button type="button" class="text-button cursor-interaction" data-action="groups-retry">Try again</button></p>`
        : '<p class="small muted" role="status">Loading your groups…</p>';
    }
    if (!groups.length) return '<div class="group-row-empty small muted">No groups yet. <button type="button" class="text-button cursor-interaction" data-go="groups">Start one</button></div>';
    return `<div class="group-rows">${groups.map((g) => {
      const net = g.owedToYouCents - g.youOweCents;
      const tone = net > 0 ? 'is-owed' : net < 0 ? 'is-owing' : '';
      return `<button type="button" class="group-row cursor-interaction" data-group-id="${esc(g.id)}"><span class="group-picture">${icon(g.kind === 'trip' ? 'luggage' : 'house')}</span><span class="group-row-copy"><strong>${esc(g.name)}</strong><span class="small muted">${g.memberCount} people</span></span><span class="group-row-net ${tone}"><strong class="money">${net === 0 ? 'Settled' : money(Math.abs(net))}</strong><span class="small">${net > 0 ? 'you’re owed' : net < 0 ? 'you owe' : 'all square'}</span></span>${icon('chevron-right')}</button>`;
    }).join('')}</div>`;
  }

  function home() {
    maybeAskConsent();
    const today = todayLocal();
    const first = getSession()?.actor?.displayName?.split(' ')[0] || 'there';
    const d = need('month');
    const dateLine = fmtDay(today, { weekday: 'long', month: 'long', day: 'numeric' });
    const addButton = `<div class="heading-actions"><button type="button" class="secondary cursor-interaction" data-action="overview-add-expense">${icon('banknote')}Cash expense</button><button type="button" class="primary cursor-interaction" data-go="transactions">${icon('receipt')}Split a transaction</button></div>`;
    if (!d) {
      return (
        heading(dateLine, `Hey ${esc(first)}.`, '', addButton) +
        syncBar(null) +
        (store.errors.month ? errorCard('month') : loadingCard())
      );
    }
    const a = d.account;
    const known = a.spendableCents !== null && a.spendableCents !== undefined;
    const weekBills = billsWithin(d.bills, today, 7);
    const billsWeek = sumCents(weekBills);
    const planWith = known ? a.spendableCents - billsWeek : null;
    const [whole, cents] = known ? money(planWith).split('.') : ['—', '—'];
    const net = d.totals.earnedCents - d.totals.spentCents;
    const series_ = series(d);
    const anyDemo = d.recent.some((r) => r.source === 'demo');
    const recent = d.recent.slice(0, 5);
    return (
      heading(
        dateLine,
        known && planWith >= 0 ? `Hey ${esc(first)}. You’ve got room.` : `Hey ${esc(first)}. Bills come first this week.`,
        '',
        addButton,
      ) +
      syncBar(d) +
      `
<div class="balance-strip"><div class="available"><div class="label">Left after this week’s bills ${icon('arrow-up-right')}</div><div class="figure display money">${whole}<span class="cents">${known ? '.' + cents : ''}</span></div><p class="footnote">${!known ? 'Refresh to read your bank balance.' : planWith >= 0 ? 'This week’s bills are covered. This is the breathing room.' : 'This week’s bills are more than what’s free right now.'}</p></div><div class="balance-math"><div class="math-line"><span class="muted">In your account</span><strong class="money">${a.balanceCents === null ? '—' : money(a.balanceCents)}</strong></div>${a.goalHoldsCents ? `<div class="math-line"><span class="muted">Set aside for goals</span><span class="money">− ${money(a.goalHoldsCents)}</span></div><p class="small muted">${(d.goalReservations || []).map((goal) => `${esc(goal.name)} ${money(goal.savedCents)}`).join(' · ')} · Stays in checking; unavailable to spend.</p>` : ''}${a.settlementHoldsCents ? `<div class="math-line"><span class="muted">Pending payment reservations</span><span class="money">− ${money(a.settlementHoldsCents)}</span></div>` : ''}<div class="math-line"><span class="muted">Bills due this week</span><span class="money">− ${money(billsWeek)}</span></div><div class="math-line"><span>Yours to plan with</span><span class="money">${known ? money(planWith) : '—'}</span></div></div></div>${cardStrip(d)}
<section class="chart-section" aria-label="Monthly money flow"><div class="section-head"><h2>The month so far</h2><span class="month-label">${fmtDay(today, { month: 'long', year: 'numeric' })}</span></div><div class="chart-summary"><p><strong class="money">${dollarLabel(d.totals.earnedCents)}</strong> earned <span aria-hidden="true">·</span> <strong class="money">${dollarLabel(d.totals.spentCents)}</strong> spent</p><span class="forecast">${icon('move-up-right')}${net >= 0 ? 'Ahead by ' + dollarLabel(net) : 'Behind by ' + dollarLabel(-net)} so far</span></div>${moneyChart('home-flow', series_, 'home')}${chartControls('home-flow', series_)}<p class="chart-note">Spending counts purchases only; transfers between accounts don’t count.${anyDemo ? ' Activity before your sandbox connected is labeled demo history.' : ''}</p></section>
<div class="under-chart"><section aria-label="Top spending categories"><div class="section-head"><h2>Where it went</h2><button type="button" class="text-button cursor-interaction" data-go="profile">Insights ${icon('arrow-up-right')}</button></div>${topCategories(d)}</section><section aria-label="Shared money"><div class="section-head"><h2>In it together</h2><button type="button" class="text-button cursor-interaction" data-go="groups">All groups ${icon('arrow-up-right')}</button></div>${groupRows()}<div class="activity"><div class="section-head" style="margin-bottom:4px"><h3>Recent transactions</h3><button type="button" class="text-button cursor-interaction" data-go="transactions">See all ${icon('arrow-up-right')}</button></div>${recent.length ? recent.map((t) => txRow(t, today)).join('') : '<p class="small muted">No transactions yet this month. Buy something at Capital Two and it shows up here.</p>'}</div></section></div>`
    );
  }

  // ── Profile ───────────────────────────────────────────────────────────
  function periodLabel(period, today) {
    if (period === 'month') return `${fmtDay(today, { month: 'short' })} 1–${Number(today.slice(8))}`;
    return period === 'quarter' ? '3 months' : '6 months';
  }

  function profile() {
    maybeAskConsent();
    const today = todayLocal();
    const overview = need('month');
    const data = needAnalytics();
    const header = heading('Insights', 'Understand the shape of your money', 'Twelve months of bank facts, reservations and clearly labeled estimates.',
      `<span class="tag">${icon('calendar-days')}${fmtDay(today, { month: 'short', day: 'numeric', year: 'numeric' })}</span>`);
    if (!data) {
      const failure = analytics.error;
      return `${header}${syncBar(overview)}${failure
        ? `<div class="data-state is-error" role="alert">${icon('info')}<div><strong>Insights could not be loaded</strong><p class="small muted">${esc(failure.message)}</p><button type="button" class="secondary" data-action="insights-retry">Try again</button></div></div>`
        : loadingCard()}`;
    }
    if (!data.connected) {
      return `${header}${syncBar(overview)}<div class="sp-empty">${icon('chart-no-axes-combined')}<h2>Connect an account to see Insights</h2><p>Your charts will appear after Capital Two activity is shared with Split.</p><button type="button" class="primary" data-action="bank-manage">Manage Capital Two</button></div>`;
    }
    if (!data.hasActivity) {
      return `${header}${syncBar(overview)}${insightCard()}<div class="sp-empty">${icon('sprout')}<h2>Your charts are ready for activity</h2><p>New users see this state instead of empty axes. Buy something or receive income at Capital Two, then refresh.</p></div>${insightCards(data)}`;
    }
    echartSpecs.set('insights-flow', cashFlowOption(data.monthly));
    if (data.categories.length) echartSpecs.set('insights-categories', categoryOption(data.categories));
    if (data.allocation.salaryCents || data.allocation.outsideSalaryCents) {
      echartSpecs.set('insights-allocation', sankeyOption(data.allocation, data.categories, data.goals));
    }
    if (data.recurring.length) echartSpecs.set('insights-recurring', recurringOption(data.range.months, data.recurring));
    if (data.calendar.days.length) echartSpecs.set('insights-calendar', calendarOption(data.calendar));
    data.goals.forEach((goal, index) => echartSpecs.set(`insights-goal-${index}`, goalOption(goal)));
    const categoryButtons = data.categories.map((row) =>
      `<button type="button" class="insight-category-link" data-insights-category="${esc(row.category)}"><span>${esc(row.category)}</span><strong class="money">${money(row.currentCents)}</strong>${icon('arrow-up-right')}</button>`).join('');
    const upcomingSchedules = data.upcomingSchedules ?? [];
    const upcoming = upcomingSchedules.length
      ? `<div class="upcoming-schedules" aria-label="Upcoming scheduled activity">${upcomingSchedules.map((schedule) =>
        `<div class="upcoming-schedule"><span class="tx-icon">${icon(schedule.kind === 'salary' ? 'banknote' : schedule.recurring ? 'repeat-2' : 'calendar-clock')}</span><span><strong>${esc(schedule.name)}</strong><span class="small muted">${schedule.kind === 'salary' ? 'Income' : esc(schedule.category)} · ${schedule.recurring ? schedule.frequency === 'biweekly' ? 'Every two weeks' : 'Monthly' : 'One time'} · ${fmtDay(schedule.nextDueOn, { month: 'short', day: 'numeric' })}</span></span><strong class="money">${schedule.kind === 'salary' ? '+ ' : '− '}${money(schedule.cents)}</strong></div>`).join('')}</div>`
      : '<div class="sp-empty"><h3>No upcoming scheduled activity</h3><p>Future Capital Two schedules will appear here.</p></div>';
    const goals = data.goals.length
      ? `<section class="insights-section"><div class="section-head"><div><h2>Goals</h2><p class="small muted">Progress and projections use confirmed savings movements.</p></div><button type="button" class="text-button" data-go="goals">Open Goals</button></div><div class="insights-goals">${data.goals.map((goal, index) => {
        const projection = goal.status === 'funded' ? 'Target reached'
          : goal.projectedDate ? `Projected ${fmtDay(goal.projectedDate, { month: 'short', day: 'numeric', year: 'numeric' })}`
            : goal.targetDate ? 'Not enough history to project' : 'No target date set';
        return `<article class="sp-card insight-goal"><div>${chartHost(`insights-goal-${index}`, `${esc(goal.name)} goal progress`, 'echart-goal')}</div><div><h3>${esc(goal.name)}</h3><p><strong class="money">${money(goal.savedCents)}</strong> of ${money(goal.targetCents)}</p><p class="small muted">${esc(projection)} · observed net pace ${money(goal.paceCentsPerDay)}/day</p></div></article>`;
      }).join('')}</div></section>`
      : '<section class="sp-empty insights-section"><h2>No goals yet</h2><p>Create a savings goal to see progress and an honest projection here.</p><button type="button" class="secondary" data-go="goals">Create a goal</button></section>';
    const sw = data.settledWithSplit;
    const settledSection = sw?.count
      ? `<section class="insights-section settled-split" aria-label="Settled with Split"><div class="section-head"><div><h2>${icon('heart-handshake')}Settled with Split</h2><p class="small muted">Settlements count in the category they paid for. Money paid back to you lowers your spending there.</p></div><button type="button" class="text-button" data-go="transactions">See transactions</button></div><div class="settled-split-grid"><div><span class="small muted">You paid back this month</span><strong class="display money">${money(sw.currentPaidCents)}</strong></div><div><span class="small muted">Paid back to you this month</span><strong class="display money">${money(sw.currentReceivedCents)}</strong></div><div><span class="small muted">Last twelve months</span><strong class="money">${money(sw.paidCents)} paid · ${money(sw.receivedCents)} back</strong><span class="small muted">${sw.count} ${sw.count === 1 ? 'settlement' : 'settlements'}</span></div></div></section>`
      : '';
    return `${header}${syncBar(overview)}${insightCard()}
      <div class="insight-facts"><span>${data.hasDemoHistory ? 'Includes labeled demo history' : 'Bank activity only'}</span><span>Snapshot ${esc(new Date(data.asOf).toLocaleString())}</span></div>
      <section class="insights-section analytics-sheet"><div class="section-head"><div><h2>Income, spending and net</h2><p class="small muted">Twelve calendar months. This month includes activity through today.</p></div></div>${chartHost('insights-flow', 'Twelve month income, spending and net chart', 'echart-flow')}</section>
      ${settledSection}
      <div class="insights-grid"><section class="insights-section analytics-sheet"><div class="section-head"><div><h2>Category pace</h2><p class="small muted">${data.baselineMonths ? `Compared with ${data.baselineMonths} prior active ${data.baselineMonths === 1 ? 'month' : 'months'}.` : 'More history is needed for monthly averages.'}</p></div></div>${data.categories.length ? chartHost('insights-categories', 'This month and average spending by category', 'echart-category') + `<div class="insight-category-links">${categoryButtons}</div>` : '<div class="sp-empty"><h3>No category spending</h3><p>Purchases will appear here after they are recorded.</p></div>'}</section>
      <section class="insights-section analytics-sheet"><div class="section-head"><div><h2>Salary allocation view</h2><p class="small muted">A planning view—not a claim that money transferred.</p></div></div>${data.allocation.salaryCents || data.allocation.outsideSalaryCents ? chartHost('insights-allocation', 'Salary allocation across spending, goals and unallocated funds', 'echart-sankey') : '<div class="sp-empty"><h3>No salary activity</h3><p>Set up or receive a salary deposit to see this allocation.</p></div>'}<p class="small muted">${esc(data.allocation.note)}</p></section></div>
      ${goals}
      <div class="insights-grid"><section class="insights-section analytics-sheet"><div class="section-head"><div><h2>Recurring history and upcoming schedules</h2><p class="small muted">Recorded repeating expenses plus future Capital Two activity.</p></div></div>${data.recurring.length ? chartHost('insights-recurring', 'Monthly recurring expenses stacked by merchant', 'echart-recurring') + `<p class="small muted">${data.recurring.some((row) => row.kind === 'detected') ? '“Looks recurring” entries are inferred from matching activity.' : 'Recorded entries came from explicit schedules.'}</p>` : '<p class="small muted">No recorded recurring transactions yet.</p>'}${upcoming}</section>
      <section class="insights-section analytics-sheet"><div class="section-head"><div><h2>Due-day calendar</h2><p class="small muted">Expected dates; no payment is initiated here.</p></div></div>${data.calendar.days.length ? chartHost('insights-calendar', 'Calendar heatmap of expected recurring costs', 'echart-calendar') : '<div class="sp-empty"><h3>No scheduled due days</h3><p>Add a recurring Capital Two payment to build this calendar.</p></div>'}</section></div>
      ${insightCards(data)}${merchantTable(data)}`;
  }

  function insightCards(data) {
    if (!data.cards.length) return '<section class="sp-empty insights-section"><h2>No credit cards connected</h2><p>Connected Capital Two cards will show utilization here.</p></section>';
    return `<section class="insights-section"><div class="section-head"><div><h2>Cards</h2><p class="small muted">Credit used comes from the provider’s available-credit fact.</p></div></div><div class="insight-card-grid">${data.cards.map((card) => {
      const known = Number.isSafeInteger(card.limitCents) && Number.isSafeInteger(card.usedCents) && card.limitCents > 0;
      const percent = known ? Math.min(100, Math.round((card.usedCents / card.limitCents) * 100)) : 0;
      return `<article class="sp-card insight-credit-card"><div class="section-head"><h3>Capital Two ••${esc(card.mask || '••••')}</h3><span class="tag">${known ? `${percent}% used` : 'Balance unavailable'}</span></div><p class="display money">${known ? money(card.usedCents) : '—'}</p><span class="category-track"><span style="width:${percent}%"></span></span><div class="math-line small"><span>Limit ${card.limitCents === null ? 'unavailable' : money(card.limitCents)}</span><span>Due date ${card.dueDate ? fmtDay(card.dueDate, { month: 'short', day: 'numeric' }) : 'unavailable'}</span></div></article>`;
    }).join('')}</div></section>`;
  }

  function merchantTable(data) {
    const sorted = [...data.merchants].sort((a, b) => {
      if (state.merchantSort === 'name') return a.name.localeCompare(b.name);
      if (state.merchantSort === 'count') return b.count - a.count || a.name.localeCompare(b.name);
      return b.cents - a.cents || a.name.localeCompare(b.name);
    });
    return `<section class="insights-section merchant-ledger" aria-label="Sortable merchant spending"><div class="section-head"><div><h2>Merchants</h2><p class="small muted">Purchases across the twelve-month window.</p></div><label class="field insight-sort">Sort<select data-merchant-sort><option value="spend" ${state.merchantSort === 'spend' ? 'selected' : ''}>Most spent</option><option value="count" ${state.merchantSort === 'count' ? 'selected' : ''}>Most transactions</option><option value="name" ${state.merchantSort === 'name' ? 'selected' : ''}>Name</option></select></label></div>${sorted.length
      ? `<div class="insight-merchant-head small muted"><span>Merchant</span><span>Transactions</span><span>Spent</span></div>${sorted.map((row) => `<div class="merchant-row"><strong>${esc(row.name)}</strong><span>${row.count}</span><strong class="money">${money(row.cents)}</strong></div>`).join('')}`
      : '<div class="sp-empty"><h3>No merchant spending</h3><p>Purchases will appear here after they are recorded.</p></div>'}</section>`;
  }

  const noRecurring = () => `<div class="sp-empty">${icon('repeat-2')}<h2>No recurring payments yet</h2><p>Rent, subscriptions and other payments you set up to repeat at Capital Two show up here with their next due date.</p></div>`;

  function profileSpending(d, today) {
    const cards = (d.cards ?? []).length ? `<section class="insight-cards" aria-label="Your cards"><div class="section-head"><h2>Your cards</h2></div>${d.cards.map((c) => cardArt(c, { compact: true })).join('')}</section>` : '';
    return cards + profileSpendingBody(d, today);
  }

  function profileSpendingBody(d, today) {
    if (!d.totals.earnedCents && !d.totals.spentCents && !d.recent.length) {
      return `<div class="sp-empty">${icon('sprout')}<h2>Nothing to look at yet</h2><p>Once you buy something or get paid at Capital Two, your spending breaks down here by category, merchant and card.</p><button type="button" class="secondary cursor-interaction" data-period="half">Look further back</button></div>`;
    }
    const totals = d.totals,
      net = totals.earnedCents - totals.spentCents,
      out = totals.spentCents,
      pct = (c) => (out ? Math.round((c / out) * 100) : 0),
      label = periodLabel(state.period, today),
      cats = [...CATEGORIES, ...d.breakdown.categories.map((c) => c.category).filter((c) => !CATEGORIES.includes(c))],
      catCents = (cat) => d.breakdown.categories.find((c) => c.category === cat)?.cents ?? 0,
      merchants = d.breakdown.merchants,
      filtered = state.category === 'all' ? merchants : merchants.filter((r) => r.category === state.category),
      chartData = series(d),
      thirty = billsWithin(d.bills, today, 30);
    return `<div class="profile-totals"><div class="profile-total"><span class="small">${icon('arrow-down-left')}Money in</span><div class="display money">${dollarLabel(totals.earnedCents)}</div></div><div class="profile-total"><span class="small">${icon('arrow-up-right')}Your spending</span><div class="display money">${dollarLabel(totals.spentCents)}</div></div><div class="profile-total"><span class="small">Deposits minus spending</span><div class="display money">${net < 0 ? '−' : '+'}${dollarLabel(Math.abs(net))}</div></div></div><section class="analytics-sheet" aria-label="Detailed cash flow"><div class="section-head"><h2>How it’s been flowing</h2><span class="small muted">USD</span></div>${moneyChart('profile-flow', chartData)}${chartControls('profile-flow', chartData, state.period)}<p class="small muted" style="margin-top:10px">${state.period === 'month' ? `Running totals, ${label}.` : 'Monthly totals. This month includes days so far.'} Purchases and Split settlements count as spending (money paid back to you lowers it); other transfers don’t.</p></section><div class="section-head"><h2>A closer look</h2><span class="small muted">${esc(label)}</span></div><div class="profile-columns"><section aria-label="Interactive spending categories"><div class="section-head" style="margin-bottom:5px"><h3>Where it went</h3><button type="button" class="text-button cursor-interaction" data-category="all">${state.category === 'all' ? 'Choose a category' : 'Clear filter'}</button></div>${cats
      .map((cat) => {
        const c = catCents(cat);
        return `<button type="button" class="category-choice cursor-interaction" data-category="${esc(cat)}" aria-pressed="${state.category === 'all' || state.category === cat}" aria-label="Filter ${esc(cat)}, ${money(c)}, ${pct(c)} percent of spending"><span class="math-line"><span>${esc(cat)}</span><span class="money">${dollarLabel(c)} <span class="muted">· ${pct(c)}%</span></span></span><span class="category-track"><span style="width:${pct(c)}%"></span></span></button>`;
      })
      .join('')}<p class="small muted" style="margin-top:8px">Select a bar to see the merchants below.</p></section><section aria-label="Payment methods"><h3 style="margin-bottom:10px">How you paid</h3>${METHOD_ICONS.map(([method, sym]) => {
      const c = d.breakdown.paymentMethods.find((m) => m.paymentMethod === method)?.cents ?? 0;
      return `<div class="payment-row">${icon(sym)}<span>${method}</span><strong class="money">${dollarLabel(c)}</strong></div>`;
    }).join('')}${d.bills.length ? `<div class="insight" style="margin-top:17px">${icon('repeat-2')}<div><div class="insight-label">The regulars</div><p>${d.bills.length} recurring ${d.bills.length === 1 ? 'cost' : 'costs'}. ${money(sumCents(thirty))} expected over the next 30 days.</p><button type="button" class="cursor-interaction" data-profile-tab="recurring">Look at the recurring stuff</button></div></div>` : ''}</section></div><section class="merchant-ledger" aria-label="Merchant spending detail"><div class="section-head"><h2>${state.category === 'all' ? 'The places behind the numbers' : esc(state.category)}</h2><span class="small muted">${filtered.length} ${filtered.length === 1 ? 'merchant' : 'merchants'}</span></div><div aria-live="polite">${
      filtered.length
        ? filtered
            .map((r) => `<div class="merchant-row"><div><strong>${esc(r.name)}</strong><div class="small">${r.count} ${r.count === 1 ? 'transaction' : 'transactions'} · ${esc(r.category)}</div></div><span class="small">${esc(r.paymentMethod)}</span><strong class="money">${money(r.cents)}</strong></div>`)
            .join('')
        : '<p class="small muted">No purchases in this view.</p>'
    }</div></section><section class="merchant-ledger" aria-label="Recent transactions"><div class="section-head"><h2>Recent transactions</h2><span class="small muted">Newest first</span></div><div class="activity">${
      d.recent.length ? d.recent.slice(0, 10).map((t) => txRow(t, today)).join('') : '<p class="small muted">No transactions in this view yet.</p>'
    }</div></section>`;
  }

  function billRows(list) {
    if (!list.length) return '<p class="small muted">Nothing due here.</p>';
    return list
      .map(
        (b) =>
          `<div class="bill-row"><span class="bill-symbol">${icon(b.icon || 'receipt')}</span><div class="bill-copy"><strong>${esc(b.name)}</strong><div class="small">${esc(b.note || '')}${b.source === 'demo' ? ' · demo schedule' : ''}<br>${fmtDay(b.nextDueOn, { month: 'short', day: 'numeric' })} · ${esc(b.paymentMethod || '')}</div></div><div class="bill-amount"><strong class="money">${money(b.amountCents)}</strong><div class="small">${b.isEstimate ? 'Estimated' : b.recurrence === 'monthly' ? 'Monthly' : b.recurrence === 'weekly' ? 'Weekly' : 'Yearly'}</div></div><button type="button" class="text-button cursor-interaction" data-bill="${esc(b.id)}" aria-label="Review ${esc(b.name)}">${icon('chevron-right')}</button></div>`,
      )
      .join('');
  }

  function profileRecurring(d, today) {
    if (!d.bills.length) return noRecurring();
    const thirty = billsWithin(d.bills, today, 30);
    const estimated = d.bills.some((b) => b.isEstimate);
    return `<div class="bill-summary"><div><div class="eyebrow muted">Expected in the next 30 days</div><div class="display money">${money(sumCents(thirty))}</div><p class="small muted">${d.bills.length} recurring ${d.bills.length === 1 ? 'cost' : 'costs'}${estimated ? ' · includes estimates' : ''}</p></div><span class="tag">${icon('repeat-2')}Monthly rhythm</span></div><div class="section-head"><h2>The regulars</h2><span class="small muted">Next due date</span></div>${billRows(d.bills)}<div class="goal-note">${icon('info')}<span>These are expected costs, not pending transfers. Changes to subscriptions are made with the provider.</span></div>`;
  }

  function profileUpcoming(d, today) {
    if (!d.bills.length) return noRecurring();
    const week = billsWithin(d.bills, today, 7);
    const later = d.bills.filter((b) => b.nextDueOn > addDays(today, 6) && b.nextDueOn <= addDays(today, 29));
    const spendable = d.account.spendableCents;
    const weekTotal = sumCents(week);
    const covered = spendable !== null && spendable !== undefined && spendable >= weekTotal;
    const dueToday = week.filter((b) => b.nextDueOn === today);
    return `<div class="bill-summary"><div><div class="eyebrow muted">Due in the next 7 days</div><div class="display money">${money(weekTotal)}</div><p class="small muted">${spendable === null || spendable === undefined ? 'Refresh to compare with your balance.' : covered ? `Covered by the ${money(spendable)} free in your account.` : `More than the ${money(spendable)} free in your account right now.`}</p></div><span class="tag">${icon('calendar-clock')}${week.length} due this week</span></div>${
      dueToday.length
        ? `<div class="upcoming-day"><span class="date-tile">${fmtDay(today, { month: 'short' }).toUpperCase()}<strong>${Number(today.slice(8))}</strong></span><div><h3>Due today</h3><p class="small muted">${dueToday.length} expected ${dueToday.length === 1 ? 'cost' : 'costs'} · ${money(sumCents(dueToday))}</p></div></div>`
        : ''
    }${billRows(week)}<div class="section-head" style="margin-top:24px"><h2>Later this month</h2><span class="small muted">${money(sumCents(later))} expected</span></div>${billRows(later)}<div class="goal-note">${icon('calendar-days')}<span>Dates and amounts are estimates from your regular bills. Your balance changes only when transactions are recorded.</span></div>`;
  }

  function billDetail(id) {
    const b = Object.values(store.data).flatMap((d) => d?.bills ?? []).find((i) => i.id === id);
    if (!b) return;
    openModal(
      'Recurring cost details',
      `<div class="modal-header"><div><div class="eyebrow">Recurring cost</div><h2>${esc(b.name)}</h2></div>${closeButton}</div><div class="amount-large display money">${money(b.amountCents)}</div><div class="detail-row"><span class="muted">Next expected</span><strong>${fmtDay(b.nextDueOn, { month: 'long', day: 'numeric', year: 'numeric' })}</strong></div><div class="detail-row"><span class="muted">Repeats</span><span>${b.recurrence[0].toUpperCase() + b.recurrence.slice(1)}</span></div><div class="detail-row"><span class="muted">Payment method</span><span>${esc(b.paymentMethod || '—')}</span></div><div class="detail-row"><span class="muted">Amount</span><span>${b.isEstimate ? 'Estimate based on recent bills' : 'Expected recurring amount'}</span></div><div class="detail-row"><span class="muted">Source</span><span>${b.source === 'demo' ? 'Demo schedule' : 'Bank sandbox'}</span></div><p style="margin-top:17px">${esc(b.note || b.name)}. This is a forecast for planning, not a payment request.</p><div class="modal-actions"><button type="button" class="primary cursor-interaction" data-action="close">Got it</button></div>`,
    );
  }

  // ── Events ────────────────────────────────────────────────────────────
  function mountMoneyCharts() {
    chartManager.mount(echartSpecs);
  }
  root.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.action === 'bank-sync') {
      sync();
      return;
    }
    if (b.dataset.action === 'overview-retry') {
      store.errors[b.dataset.period] = null;
      render();
      return;
    }
    if (b.dataset.action === 'insights-retry') {
      analytics.error = null;
      analytics.revision = -1;
      render();
      return;
    }
    if (b.dataset.insightsCategory) {
      transactionFeed.category = b.dataset.insightsCategory;
      resetTransactionFeed();
      state.page = 'transactions';
      render();
      persist();
      return;
    }
    if (b.dataset.profileTab) {
      state.page = 'profile';
      state.profileTab = b.dataset.profileTab;
      render();
      persist();
    }
    if (b.dataset.period && PERIODS[b.dataset.period] !== undefined) {
      state.period = b.dataset.period;
      state.category = 'all';
      render();
      persist();
    }
    if (b.dataset.category) {
      state.page = 'profile';
      state.category = state.category === b.dataset.category ? 'all' : b.dataset.category;
      render();
      persist();
    }
    if (b.dataset.bill) billDetail(b.dataset.bill);
  });

  // ── Add an expense (B6) ───────────────────────────────────────────────
  // Overview stays the page underneath: the form creates an A2 draft, the
  // review is A5's shared ticket, and only its Confirm calls A3.
  let expenseOpening = false;
  let lastGroupId = null;
  const EXPENSE_FORM = 'sp-overview-expense-form';
  const expensePurchases = new WeakMap();
  const focusAddButton = () => root.querySelector('[data-action="overview-add-expense"]')?.focus({ preventScroll: true });

  // B15 · Re-categorize a transaction in Split; the bank's category is kept.
  function openCategoryDialog(id) {
    const t = transactionFeed.rows?.find((row) => row.id === id);
    if (!t) return;
    const choices = transactionFeed.categoryChoices?.length ? transactionFeed.categoryChoices : CATEGORIES;
    const options = [...new Set([...choices, t.category].filter(Boolean))];
    openModal('Change category', `<div class="modal-header"><div><div class="eyebrow">${esc(t.merchantName || t.description)} · ${money(t.amountCents)}</div><h2>Change category</h2></div>${closeButton}</div>
      <form id="sp-category-form" data-transaction="${esc(t.id)}"><fieldset class="category-choices"><legend class="sr-only">Category</legend>${options
        .map((c) => `<label class="category-choice-row"><input type="radio" name="category" value="${esc(c)}" ${c === t.category ? 'checked' : ''}><span>${esc(c)}</span>${c === t.bankCategory ? '<span class="small muted">Capital Two</span>' : ''}</label>`).join('')}</fieldset>
      <p class="small muted">Capital Two says <strong>${esc(t.bankCategory || 'no category')}</strong>. Your choice is used in Split’s charts and filters; the bank’s record doesn’t change.</p>
      <p class="error" role="alert"></p>
      <div class="modal-actions">${t.categoryOverridden ? '<button type="button" class="secondary" data-action="category-reset">Use Capital Two’s</button>' : '<button type="button" class="secondary" data-action="close">Cancel</button>'}<button type="submit" class="primary">Save category</button></div></form>`);
  }

  async function saveCategory(form, category) {
    const button = form.querySelector('[type="submit"]');
    button.disabled = true;
    try {
      const { transaction } = await apiRequest(`/api/banking/transactions/${encodeURIComponent(form.dataset.transaction)}/category`, { method: 'POST', body: { category } });
      const row = transactionFeed.rows?.find((r) => r.id === transaction.id);
      if (row) Object.assign(row, transaction);
      closeModal();
      toast(`Category set to ${transaction.category}.`);
      store.data = {};
      financialChanged();
    } catch (err) {
      if (form.isConnected) form.querySelector('[role="alert"]').textContent = err.message;
      button.disabled = false;
    }
  }

  /** The recent transaction a Split button refers to (from any loaded period). */
  function findTransaction(id) {
    const row = transactionFeed.rows?.find((item) => item.id === id);
    if (row) return row;
    for (const d of Object.values(store.data)) {
      const t = d?.recent?.find((row) => row.id === id);
      if (t) return t;
    }
    return null;
  }

  async function openAddExpense(button, purchases = []) {
    if (expenseOpening) return;
    expenseOpening = true;
    button.disabled = true;
    try {
      const { groups } = await apiRequest('/api/groups');
      if (!groups.length) {
        toast('Create a group in Together before adding a shared expense.');
        return;
      }
      const details = await Promise.all(groups.map((g) => apiRequest(`/api/groups/${encodeURIComponent(g.id)}`)));
      if (!['home', 'transactions'].includes(state.page)) return;
      const preferred = (purchases.length && state.transactionGroupId) || purchases[0]?.suggestedGroupId || lastGroupId;
      const selected = groups.some((g) => g.id === preferred) ? preferred : groups[0].id;
      const people = details.map(({ group, members }) => `<fieldset class="expense-people" data-group-members="${esc(group.id)}" ${group.id === selected ? '' : 'hidden disabled'}><legend>People</legend>${members.map((m) => `
        <div><label class="check-label"><input type="checkbox" name="participant" value="${esc(m.userId)}" checked>${m.isYou ? 'You · paid the full amount' : esc(m.displayName)}</label>
        ${purchases.map((t) => `<label class="field" data-allocation hidden>${esc(m.displayName)} · ${esc(t.merchantName || t.description)}<input disabled inputmode="decimal" name="share-${esc(t.id)}-${esc(m.userId)}"></label>`).join('')}</div>`).join('')}</fieldset>`).join('');
      const sources = purchases.map((t) => `<div class="split-source">${icon(t.accountKind === 'credit_card' ? 'credit-card' : 'landmark')}<span><strong>${esc(t.merchantName || t.description)}</strong><span class="small muted">Capital Two ${t.accountKind === 'credit_card' ? 'card' : 'checking'}${t.accountMask ? ` ••${esc(t.accountMask)}` : ''}</span></span><strong class="money">${money(t.amountCents)}</strong></div>`).join('');
      const title = purchases.length ? 'Split purchases' : 'Add a cash expense';
      const fields = purchases.length ? `<label class="field">Split method<select name="splitMode"><option value="equal">Equal</option><option value="exact">Exact amounts (USD)</option><option value="percentage">Percentage</option></select></label>` : `
        <label class="field">Merchant<input name="merchant" required maxlength="60" autocomplete="off"></label><div class="field-grid"><label class="field">Total, USD<input name="amount" required inputmode="decimal" autocomplete="off" placeholder="42.00"></label><label class="field">Category<select name="category">${CATEGORIES.map((c) => `<option>${esc(c)}</option>`).join('')}</select></label></div>`;
      openModal(title, `<div class="modal-header"><h2>${title}</h2>${closeButton}</div><form id="${EXPENSE_FORM}">${sources}<label class="field">Group<select name="groupId">${groups.map((g) => `<option value="${esc(g.id)}" ${g.id === selected ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}</select></label>${fields}${people}<p class="error" role="alert"></p><div class="modal-actions"><button type="button" class="secondary" data-action="close">Cancel</button><button type="submit" class="primary">Review split</button></div><div class="modal-fine">Nothing is saved until you confirm the expense. No money moves.</div></form>`);
      expensePurchases.set(root.querySelector('#' + EXPENSE_FORM), purchases);
    } catch (err) {
      toast(err.message);
    } finally {
      expenseOpening = false;
      if (button.isConnected) button.disabled = false;
    }
  }

  async function submitExpense(form, fd) {
    const button = form.querySelector('[type="submit"]');
    const error = form.querySelector('[role="alert"]');
    if (button.disabled) return;
    const groupId = String(fd.get('groupId'));
    const participantIds = fd.getAll('participant');
    if (!participantIds.length) {
      error.textContent = 'Choose at least one person to split with.';
      return;
    }
    button.disabled = true;
    form.setAttribute('aria-busy', 'true');
    error.textContent = '';
    try {
      const purchases = expensePurchases.get(form) ?? [];
      const mode = fd.get('splitMode');
      const request = { groupId, participantIds };
      if (purchases.length) {
        request.purchases = purchases.map((t) => ({
          bankRef: { accountId: t.accountId, providerKey: t.providerKey },
          merchant: t.merchantName || t.description || 'Bank purchase', category: t.category, cents: t.amountCents,
          allocation: { mode, values: mode === 'equal' ? undefined : Object.fromEntries(participantIds.map((id) => [
            id, usdToCents(String(fd.get(`share-${t.id}-${id}`) ?? '').trim(), { allowZero: true }),
          ])) },
        }));
      } else {
        Object.assign(request, { merchant: String(fd.get('merchant')).trim(), category: fd.get('category'),
          cents: usdToCents(String(fd.get('amount') ?? '').trim()) });
      }
      const response = await apiRequest('/api/expense-drafts', { method: 'POST', body: request });
      const [draft, ...additionalDrafts] = response.drafts ?? [response.draft];
      if (!form.isConnected) return;
      lastGroupId = groupId;
      const groupName = form.querySelector(`option[value="${CSS.escape(groupId)}"]`)?.textContent ?? '';
      registerReview(draft, {
        additionalDrafts,
        onConfirmed: () => {
          for (const t of purchases) selectedTransactions.delete(t.id);
          if (!['home', 'transactions'].includes(state.page)) return;
          render();
          focusAddButton();
        },
        onDiscard: () => {
          toast('Discarded. Nothing was saved.');
          focusAddButton();
        },
      });
      // Close first so focus returns to "Add an expense" when the review closes.
      closeModal();
      openModal('Review split', `<div class="modal-header"><div><div class="eyebrow">${esc(groupName)} · not saved yet</div><h2>Review the split</h2></div>${closeButton}</div>${draftTicket(draft, additionalDrafts)}`);
    } catch (err) {
      if (form.isConnected) error.textContent = err.message;
      announce(err.message);
    } finally {
      button.disabled = false;
      form.setAttribute('aria-busy', 'false');
    }
  }

  root.addEventListener('change', (e) => {
    const input = e.target;
    if (input.dataset.merchantSort !== undefined) {
      state.merchantSort = input.value;
      render();
      persist();
      return;
    }
    if (input.dataset.txFilter) {
      selectedTransactions.clear();
      transactionFeed[input.dataset.txFilter] = input.type === 'checkbox' ? input.checked : input.value;
      resetTransactionFeed();
      render();
      root.querySelector(`[data-tx-filter="${input.dataset.txFilter}"]`)?.focus();
      return;
    }
    if (input.dataset.selectTransaction) {
      const id = input.dataset.selectTransaction;
      if (input.checked && selectedTransactions.size >= 25) {
        input.checked = false;
        toast('Select up to 25 purchases at a time.');
      } else if (input.checked) selectedTransactions.set(id, findTransaction(id));
      else selectedTransactions.delete(id);
      root.querySelector('[data-tx-selection]').innerHTML = transactionBatchButton();
      return;
    }
    const form = input.form;
    if (form?.id !== EXPENSE_FORM) return;
    const groupId = form.elements.groupId.value;
    const mode = form.elements.splitMode?.value;
    form.querySelectorAll('[data-group-members]').forEach((fs) => {
      const on = fs.dataset.groupMembers === groupId;
      fs.hidden = !on;
      fs.disabled = !on;
      fs.querySelectorAll('[data-allocation]').forEach((label) => {
        const enabled = on && mode && mode !== 'equal' && label.parentElement.querySelector('[name="participant"]').checked;
        label.hidden = !enabled;
        const share = label.querySelector('input');
        share.disabled = !enabled;
        share.required = Boolean(enabled);
        share.placeholder = mode === 'percentage' ? '50.00' : '12.00';
      });
    });

  });
  root.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.action === 'overview-add-expense') void openAddExpense(b);
    if (b.dataset.action === 'split-tx') {
      const t = findTransaction(b.dataset.txId);
      if (t) void openAddExpense(b, [t]);
    }
    if (b.dataset.action === 'split-selected') void openAddExpense(b, [...selectedTransactions.values()]);
    if (b.dataset.action === 'tx-more' && !transactionFeed.request) {
      void loadTransactions(transactionFeed.nextOffset ?? 0);
      render();
    }
    if (b.dataset.action === 'bank-manage') void openBankConnect();
    if (b.dataset.txCategory) openCategoryDialog(b.dataset.txCategory);
    if (b.dataset.action === 'category-reset') {
      const form = root.querySelector('#sp-category-form');
      if (form) void saveCategory(form, null);
    }
    if (b.dataset.action === 'bank-allow') void connectBank(b);
    if (b.dataset.action === 'bank-sync-now') {
      closeModal();
      void sync();
    }
    if (b.dataset.action === 'insight-read' && insight.revision === financialRevision()) {
      const onError = () => announce('Couldn’t read the summary aloud.');
      if (!readAloud(insight.data?.answer, { owner: 'insight', onError })) onError();
    }
    if (b.dataset.action === 'insight-retry') {
      insight.revision = -1;
      insight.error = null;
      render();
    }
    if (b.dataset.action === 'groups-retry') {
      groupStore.error = null;
      render();
    }
  });
  function handleOverviewForm(form, fd) {
    if (form.id === 'sp-category-form') {
      const category = fd.get('category');
      if (category) void saveCategory(form, String(category));
      return;
    }
    if (form.id === EXPENSE_FORM) void submitExpense(form, fd);
  }

  function observe() {
    // A Capital Two action already imported its receipt. Open the existing
    // review directly, without waiting for the periodic bank sync.
    const url = new URL(window.location.href), target = url.searchParams.get('split');
    if (target) {
      url.searchParams.delete('split'); window.history.replaceState(null, '', url);
      if (/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/iu.test(target) && state.page === 'transactions') {
        void apiRequest(`/api/banking/transactions?id=${encodeURIComponent(target)}`).then(({ transactions }) => {
          const purchase = transactions.find((transaction) => transaction.id === target);
          if (!purchase || !splittable(purchase) || purchase.splitGroupName) {
            toast('This purchase is unavailable to split. Check bank sharing and whether it is already split.'); return;
          }
          if (state.page === 'transactions') void openAddExpense(root.ownerDocument.createElement('button'), [purchase]);
        }).catch(() => toast('The purchase could not be opened. Try it from Transactions.'));
      }
    }
    new ResizeObserver(() => chartManager.resize()).observe(view);
  }
  function resetCharts() {
    echartSpecs = new Map();
    chartManager.dispose();
  }

  return { home, profile, transactions, bankLabel, openBankConnect, mountMoneyCharts, resetCharts, observe, handleOverviewForm, tx };
}
