import { apiRequest, getSession } from '../../api/session.js';
import { financialChanged, financialRevision, subscribeFinancialChanges } from '../../api/financial-state.js';
import { usdToCents } from '../../lib/money.js';

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
  let chartRegistry = {},
    chartVisibility = { earned: true, spent: true };

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
    const width = Math.max(
        180,
        Math.round(
          view.getBoundingClientRect().width -
            (mode === 'profile' ? (innerWidth < 620 ? 28 : 44) : 0),
        ),
      ),
      height = 230,
      left = 42,
      right = mode === 'home' ? 58 : 14,
      top = 24,
      bottom = 185,
      plot = width - left - right,
      max = Math.max(1, ...data.flatMap((d) => [d.earned, d.spent])),
      step = max > 300000 ? 300000 : max > 60000 ? 60000 : 15000,
      ceiling = Math.ceil(max / step) * step;
    const x = (i) => left + (i / Math.max(1, data.length - 1)) * plot,
      y = (c) => bottom - (c / ceiling) * (bottom - top),
      path = (key) =>
        data.map((d, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(d[key]).toFixed(1)}`).join('');
    chartRegistry[id] = { data, width, left, right, top, bottom, ceiling, x, y, mode };
    const last = data.length - 1;
    const ticks =
      data.length <= (width < 430 ? 4 : 7)
        ? data.map((_, i) => i)
        : width < 430
          ? [0, Math.floor(last / 2), last]
          : [0, Math.round(last / 4), Math.round(last / 2), Math.round(last * 0.75), last];
    const axis = (v) => (v >= 100000 ? '$' + (v / 100000).toFixed(1) + 'k' : dollarLabel(Math.round(v)));
    // End-of-line labels (home): keep them at least 14px apart so close
    // totals never print on top of each other.
    const endY = { earned: y(data[last].earned), spent: y(data[last].spent) };
    if (Math.abs(endY.earned - endY.spent) < 14) {
      const mid = (endY.earned + endY.spent) / 2;
      const earnedAbove = data[last].earned >= data[last].spent;
      endY.earned = mid + (earnedAbove ? -7 : 7);
      endY.spent = mid + (earnedAbove ? 7 : -7);
    }
    return `<div class="interactive-chart" data-chart-id="${id}"><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Interactive income versus spending chart. Drag or use the slider to inspect values."><title>Income and spending in USD</title><g>${[1, 2, 3]
      .map((i) => {
        const v = (i * ceiling) / 3;
        return `<path d="M${left} ${y(v)}H${width - right}" stroke="var(--sp-line)" stroke-width="1"/><text x="0" y="${y(v) + 4}">${axis(v)}</text>`;
      })
      .join('')}${[...new Set(ticks)]
      .map((i) => `<text x="${x(i)}" y="207" text-anchor="${i === last ? 'end' : i === 0 ? 'start' : 'middle'}">${esc(data[i].label)}</text>`)
      .join('')}</g>${['earned', 'spent']
      .map((key) => {
        const color = key === 'earned' ? 'var(--sp-income)' : 'var(--sp-spend)';
        return `<g data-series="${key}" ${chartVisibility[key] ? '' : 'opacity="0"'}><path d="${path(key)}" fill="none" stroke="${color}" stroke-width="2.7" stroke-linejoin="round"/>${mode === 'home' ? `<text x="${width - right + 7}" y="${endY[key] + 4}" style="fill:${color};font-weight:600">${dollarLabel(data[last][key])}</text>` : ''}<circle data-hover-marker="${key}" cx="${x(0)}" cy="${y(data[0][key])}" r="4" fill="${color}" opacity="0"/></g>`;
      })
      .join('')}<line data-guide x1="${left}" x2="${left}" y1="${top}" y2="${bottom}" stroke="var(--sp-muted)" stroke-width="1" stroke-dasharray="3 4" opacity="0"/><rect data-hit x="${left}" y="${top}" width="${plot}" height="${bottom - top}" fill="transparent"/></svg><div class="chart-readout" data-readout aria-live="off"><span class="muted">Inspect a point →</span><span>Earned <strong>${dollarLabel(data[last].earned)}</strong></span><span>Spent <strong>${dollarLabel(data[last].spent)}</strong></span></div></div>`;
  }

  function showChartPoint(el, fraction, announceResult = false) {
    const c = chartRegistry[el.dataset.chartId];
    if (!c) return;
    const f = Math.max(0, Math.min(c.data.length - 1, fraction * (c.data.length - 1))),
      i = Math.floor(f),
      next = Math.min(c.data.length - 1, i + 1),
      t = f - i,
      values = {
        earned: Math.round(c.data[i].earned * (1 - t) + c.data[next].earned * t),
        spent: Math.round(c.data[i].spent * (1 - t) + c.data[next].spent * t),
      },
      px = c.x(f);
    const guide = el.querySelector('[data-guide]');
    guide.setAttribute('x1', px);
    guide.setAttribute('x2', px);
    guide.setAttribute('opacity', '1');
    ['earned', 'spent'].forEach((key) => {
      const mark = el.querySelector(`[data-hover-marker="${key}"]`);
      mark.setAttribute('cx', px);
      mark.setAttribute('cy', c.y(values[key]));
      mark.setAttribute('opacity', '1');
    });
    const range = root.querySelector(`[data-chart-range="${el.dataset.chartId}"]`);
    if (range) {
      range.value = Math.round(f);
      range.setAttribute('aria-valuetext', c.data[Math.round(f)].label);
    }
    const d = c.data[Math.round(f)],
      between = t > 0.03 && t < 0.97,
      label = between ? `${c.data[i].label} → ${c.data[next].label}` : d.label;
    el.querySelector('[data-readout]').innerHTML =
      `<strong>${esc(label)}${between ? ' · between recorded points' : ''}</strong>${['earned', 'spent']
        .filter((k) => chartVisibility[k])
        .map((k) => `<span>${k === 'earned' ? 'Earned' : 'Spent'} <strong>${dollarLabel(values[k])}</strong></span>`)
        .join('')}`;
    if (announceResult) announce(`${d.label}. Earned ${money(values.earned)}, spent ${money(values.spent)}.`);
  }

  function chartControls(id, data, period = 'month') {
    return `<div>${['earned', 'spent'].map((k) => `<button type="button" class="chart-toggle cursor-interaction" data-toggle-series="${k}" aria-pressed="${chartVisibility[k]}"><span class="chart-swatch ${k}"></span>${k === 'earned' ? 'Earned' : 'Spent'}</button>`).join('')}</div><div class="chart-range sr-only"><label for="${id}-range">Inspect ${period === 'month' ? 'a day' : 'a month'}</label><input type="range" id="${id}-range" data-chart-range="${id}" min="0" max="${data.length - 1}" step="1" value="${data.length - 1}" aria-label="Inspect ${id === 'home-flow' ? 'overview' : 'profile'} chart date"></div>`;
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
    const label = t.salary ? 'Salary' : t.kind === 'transfer' ? 'Transfer' : t.kind === 'deposit' ? 'Deposit' : t.category || 'Purchase';
    // On Transactions the category is a button: re-categorize in Split (B15).
    const categoryPart = selectable && t.kind === 'purchase'
      ? `<button type="button" class="tx-category" data-tx-category="${esc(t.id)}" aria-label="Change category for ${esc(t.merchantName || t.description)}, now ${esc(label)}">${esc(label)}${t.categoryOverridden ? ' <span class="small muted">· yours</span>' : ''}${icon('chevron-down')}</button>`
      : esc(label);
    const flags = [
      t.accountKind === 'credit_card' ? `card${t.accountMask ? ` ••${esc(t.accountMask)}` : ''}` : null,
      t.status === 'pending' ? 'pending' : null,
      t.source === 'demo' ? 'demo history' : null,
    ].filter(Boolean);
    // B15 · What the bank tells us: salary and recurring payments.
    const badges = [
      t.salary ? `<span class="tx-badge is-salary">${icon('banknote')}Salary</span>` : '',
      t.recurring === 'scheduled' ? `<span class="tx-badge is-recurring" title="Paid by a Capital Two recurring payment${t.recurringPayee ? ` to ${esc(t.recurringPayee)}` : ''}">${icon('repeat-2')}Recurring</span>` : '',
      t.recurring === 'detected' ? `<span class="tx-badge is-detected" title="Same merchant and amount as last month">${icon('repeat-2')}Looks recurring</span>` : '',
    ].join('');
    const sign = t.direction === 'credit' ? '+ ' : '− ';
    const symbol = t.kind === 'transfer' ? 'repeat-2' : CATEGORY_ICONS[t.category] || (t.kind === 'deposit' ? 'arrow-down-left' : 'receipt');
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
    const filters = `<div class="sp-card tx-filters">
      <label class="field">Account<select data-tx-filter="account"><option value="">All accounts</option><option value="checking" ${feed.account === 'checking' ? 'selected' : ''}>Checking</option><option value="credit_card" ${feed.account === 'credit_card' ? 'selected' : ''}>Credit card</option></select></label>
      <label class="field">Category<select data-tx-filter="category"><option value="">All categories</option>${[...new Set([...feed.categories, feed.category].filter(Boolean))].map((category) => `<option ${feed.category === category ? 'selected' : ''}>${esc(category)}</option>`).join('')}</select></label>
      <label class="check-label"><input type="checkbox" data-tx-filter="unsplit" ${feed.unsplit ? 'checked' : ''}>Not yet split</label>
      <button type="button" class="secondary" data-action="overview-add-expense">Cash expense</button>
      <span data-tx-selection>${transactionBatchButton()}</span>
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
      ? `<p>${esc(data.answer)}</p><span class="small muted">Worked out at ${clock(data.asOf)} from your balance and this month’s activity.</span>`
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
    const holds = (a.goalHoldsCents || 0) + (a.settlementHoldsCents || 0);
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
<div class="balance-strip"><div class="available"><div class="label">Left after this week’s bills ${icon('arrow-up-right')}</div><div class="figure display money">${whole}<span class="cents">${known ? '.' + cents : ''}</span></div><p class="footnote">${!known ? 'Refresh to read your bank balance.' : planWith >= 0 ? 'This week’s bills are covered. This is the breathing room.' : 'This week’s bills are more than what’s free right now.'}</p></div><div class="balance-math"><div class="math-line"><span class="muted">In your account</span><strong class="money">${a.balanceCents === null ? '—' : money(a.balanceCents)}</strong></div>${holds ? `<div class="math-line"><span class="muted">Set aside for goals and payments</span><span class="money">− ${money(holds)}</span></div>` : ''}<div class="math-line"><span class="muted">Bills due this week</span><span class="money">− ${money(billsWeek)}</span></div><div class="math-line"><span>Yours to plan with</span><span class="money">${known ? money(planWith) : '—'}</span></div></div></div>${cardStrip(d)}
<section class="chart-section" aria-label="Monthly money flow"><div class="section-head"><h2>The month so far</h2><span class="month-label">${fmtDay(today, { month: 'long', year: 'numeric' })}</span></div><div class="chart-summary"><p><strong class="money">${dollarLabel(d.totals.earnedCents)}</strong> earned <span aria-hidden="true">·</span> <strong class="money">${dollarLabel(d.totals.spentCents)}</strong> spent</p><span class="forecast">${icon('move-up-right')}${net >= 0 ? 'Ahead by ' + dollarLabel(net) : 'Behind by ' + dollarLabel(-net)} so far</span></div>${moneyChart('home-flow', series_, 'home')}${chartControls('home-flow', series_)}<p class="chart-note">Spending counts purchases only; transfers between accounts don’t count.${anyDemo ? ' Activity before your sandbox connected is labeled demo history.' : ''}</p></section>
<div class="under-chart"><section aria-label="Top spending categories"><div class="section-head"><h2>Where it went</h2><button type="button" class="text-button cursor-interaction" data-go="profile">Insights ${icon('arrow-up-right')}</button></div>${topCategories(d)}${insightCard()}</section><section aria-label="Shared money"><div class="section-head"><h2>In it together</h2><button type="button" class="text-button cursor-interaction" data-go="groups">All groups ${icon('arrow-up-right')}</button></div>${groupRows()}<div class="activity"><div class="section-head" style="margin-bottom:4px"><h3>Recent transactions</h3><button type="button" class="text-button cursor-interaction" data-go="transactions">See all ${icon('arrow-up-right')}</button></div>${recent.length ? recent.map((t) => txRow(t, today)).join('') : '<p class="small muted">No transactions yet this month. Buy something at Capital Two and it shows up here.</p>'}</div></section></div>`
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
    const tab = state.profileTab;
    const period = tab === 'spending' ? state.period : 'month';
    const d = need(period);
    return `${heading('Insights', 'Where your money goes', '', `<span class="tag">${icon('calendar-days')}${fmtDay(today, { month: 'short', day: 'numeric', year: 'numeric' })}</span>`)}<div class="profile-toolbar"><div class="profile-nav" aria-label="Profile detail sections">${[
      ['spending', 'Spending'],
      ['recurring', 'Recurring'],
      ['upcoming', 'Coming up'],
    ]
      .map(([v, t]) => `<button type="button" class="profile-subtab cursor-interaction" data-profile-tab="${v}" aria-pressed="${tab === v}">${t}</button>`)
      .join('')}</div>${
      tab === 'spending'
        ? `<div class="period-picker" aria-label="Cash flow period">${Object.keys(PERIODS)
            .map((v) => `<button type="button" data-period="${v}" aria-pressed="${state.period === v}" class="cursor-interaction">${periodLabel(v, today)}</button>`)
            .join('')}</div>`
        : ''
    }</div>${syncBar(d)}${tab === 'recurring' ? '<section class="sp-card" data-recurring-host aria-label="Recurring splits"></section>' : ''}${
      !d
        ? store.errors[period]
          ? errorCard(period)
          : loadingCard()
        : tab === 'spending'
          ? profileSpending(d, today)
          : tab === 'recurring'
            ? profileRecurring(d, today)
            : profileUpcoming(d, today)
    }`;
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
    return `<div class="profile-totals"><div class="profile-total"><span class="small">${icon('arrow-down-left')}Money in</span><div class="display money">${dollarLabel(totals.earnedCents)}</div></div><div class="profile-total"><span class="small">${icon('arrow-up-right')}Your spending</span><div class="display money">${dollarLabel(totals.spentCents)}</div></div><div class="profile-total"><span class="small">Deposits minus spending</span><div class="display money">${net < 0 ? '−' : '+'}${dollarLabel(Math.abs(net))}</div></div></div><section class="analytics-sheet" aria-label="Detailed cash flow"><div class="section-head"><h2>How it’s been flowing</h2><span class="small muted">USD</span></div>${moneyChart('profile-flow', chartData)}${chartControls('profile-flow', chartData, state.period)}<p class="small muted" style="margin-top:10px">${state.period === 'month' ? `Running totals, ${label}.` : 'Monthly totals. This month includes days so far.'} Purchases count as spending; transfers don’t.</p></section><div class="section-head"><h2>A closer look</h2><span class="small muted">${esc(label)}</span></div><div class="profile-columns"><section aria-label="Interactive spending categories"><div class="section-head" style="margin-bottom:5px"><h3>Where it went</h3><button type="button" class="text-button cursor-interaction" data-category="all">${state.category === 'all' ? 'Choose a category' : 'Clear filter'}</button></div>${cats
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
  function chartDataFor(id) {
    return series(store.data[id === 'home-flow' ? 'month' : state.period]);
  }

  function mountMoneyCharts() {
    root.querySelectorAll('[data-chart-id]').forEach((el) => showChartPoint(el, 1));
  }
  function pointerFraction(e, el) {
    const c = chartRegistry[el.dataset.chartId],
      r = el.querySelector('svg').getBoundingClientRect();
    return (((e.clientX - r.left) / r.width) * c.width - c.left) / (c.width - c.left - c.right);
  }
  root.addEventListener('pointermove', (e) => {
    const el = e.target.closest('[data-chart-id]');
    if (el && chartRegistry[el.dataset.chartId]) showChartPoint(el, pointerFraction(e, el));
  });
  root.addEventListener('pointerdown', (e) => {
    const el = e.target.closest('[data-chart-id]');
    if (el && chartRegistry[el.dataset.chartId]) showChartPoint(el, pointerFraction(e, el), true);
  });
  root.addEventListener('keydown', (e) => {
    // Arrow keys on a focused chart step through points.
    const el = e.target.closest?.('[data-chart-id]');
    const range = el && root.querySelector(`[data-chart-range="${el.dataset.chartId}"]`);
    if (!range || !['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    e.preventDefault();
    range.value = Math.max(0, Math.min(Number(range.max), Number(range.value) + (e.key === 'ArrowRight' ? 1 : -1)));
    showChartPoint(el, Number(range.value) / Math.max(1, Number(range.max)), true);
  });
  root.addEventListener('input', (e) => {
    if (e.target.dataset.chartRange) {
      const el = root.querySelector(`[data-chart-id="${e.target.dataset.chartRange}"]`);
      showChartPoint(el, Number(e.target.value) / Math.max(1, Number(e.target.max)), true);
    }
  });
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
    if (b.dataset.toggleSeries) {
      const k = b.dataset.toggleSeries;
      if (chartVisibility[k] && !chartVisibility[k === 'earned' ? 'spent' : 'earned']) return;
      chartVisibility[k] = !chartVisibility[k];
      root.querySelectorAll(`[data-series="${k}"]`).forEach((n) => n.setAttribute('opacity', chartVisibility[k] ? '1' : '0'));
      root.querySelectorAll(`[data-toggle-series="${k}"]`).forEach((n) => n.setAttribute('aria-pressed', chartVisibility[k]));
      mountMoneyCharts();
    }
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
      const preferred = purchases[0]?.suggestedGroupId || lastGroupId;
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
    let lastChartWidth = 0;
    new ResizeObserver(() => {
      const w = Math.round(view.getBoundingClientRect().width);
      if (w === lastChartWidth) return;
      lastChartWidth = w;
      root.querySelectorAll('[data-chart-id]').forEach((el) => {
        const id = el.dataset.chartId;
        const data = chartDataFor(id);
        if (data.length) el.outerHTML = moneyChart(id, data, id === 'home-flow' ? 'home' : 'profile');
      });
      mountMoneyCharts();
    }).observe(view);
  }
  function resetCharts() {
    chartRegistry = {};
  }

  return { home, profile, transactions, bankLabel, openBankConnect, mountMoneyCharts, resetCharts, observe, handleOverviewForm, tx };
}
