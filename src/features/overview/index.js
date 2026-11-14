export function createOverview({ root, view, state, demo, icon, money, dollarLabel, esc, heading, stack, shareFor, render, persist, announce, openModal, closeModal, closeButton, toast }) {
  state.profileTab = state.profileTab || 'spending';
  state.period = state.period || 'month';
  state.category = state.category || 'all';
  let chartRegistry = {},
    chartVisibility = { earned: true, spent: true };
  const merchants = [
    {
      name: 'Rent',
      category: 'Home & bills',
      method: 'Bank transfer',
      cents: 60000,
      count: 1,
      icon: 'house',
    },
    {
      name: 'DoorDash',
      category: 'Food & drink',
      method: 'Card',
      cents: 14000,
      count: 5,
      icon: 'utensils',
    },
    {
      name: 'Class supplies',
      category: 'Other',
      method: 'Card',
      cents: 8000,
      count: 2,
      icon: 'notebook-pen',
    },
    {
      name: 'Concert tickets',
      category: 'Just for fun',
      method: 'Card',
      cents: 9200,
      count: 1,
      icon: 'ticket',
    },
    {
      name: 'Campus café',
      category: 'Food & drink',
      method: 'Card',
      cents: 5400,
      count: 12,
      icon: 'coffee',
    },
    {
      name: 'Transit',
      category: 'Getting around',
      method: 'Contactless',
      cents: 4800,
      count: 8,
      icon: 'train-front',
    },
    {
      name: 'Trader Joe’s',
      category: 'Food & drink',
      method: 'Card',
      cents: 4000,
      count: 3,
      icon: 'shopping-basket',
    },
    {
      name: 'Laundry',
      category: 'Other',
      method: 'Cash',
      cents: 2000,
      count: 4,
      icon: 'washing-machine',
    },
    {
      name: 'Utilities',
      category: 'Home & bills',
      method: 'Bank transfer',
      cents: 1800,
      count: 1,
      icon: 'plug',
    },
  ];
  const bills = [
    {
      name: 'Rent',
      amount: 80000,
      day: 14,
      method: 'Bank transfer',
      icon: 'house',
      note: 'Puffton 4 · your share',
      estimate: false,
    },
    {
      name: 'Utilities',
      amount: 6000,
      day: 14,
      method: 'Bank transfer',
      icon: 'plug',
      note: 'Puffton 4 · estimated share',
      estimate: true,
    },
    {
      name: 'Spotify Student',
      amount: 1199,
      day: 18,
      method: 'Card · 0421',
      icon: 'music-2',
      note: 'Monthly subscription',
    },
    {
      name: 'Cloud storage',
      amount: 299,
      day: 21,
      method: 'Card · 0421',
      icon: 'cloud',
      note: 'Monthly subscription',
    },
    {
      name: 'Campus gym',
      amount: 2500,
      day: 25,
      method: 'Card · 0421',
      icon: 'dumbbell',
      note: 'Monthly membership',
    },
    {
      name: 'Phone plan',
      amount: 4000,
      day: 28,
      method: 'Card · 0421',
      icon: 'smartphone',
      note: 'Monthly plan',
    },
  ];
  function spendingRows() {
    return [
      ...merchants,
      ...(state.logged
        ? [
            {
              name: demo.draft.merchant,
              category: demo.draft.category === 'Groceries' ? 'Food & drink' : demo.draft.category,
              method: 'Card',
              cents: shareFor('Maya'),
              count: 1,
              icon: 'receipt',
            },
          ]
        : []),
    ];
  }
  function periodData(period = 'month', mode = 'profile') {
    const own = state.logged ? shareFor('Maya') : 0;
    const history = [
      ['Jun', 280000, 248000],
      ['Jul', 300000, 260000],
      ['Aug', 276000, 260000],
      ['Sep', 310000, 278000],
      ['Oct', 286000, 254000],
      ['Nov 1–13', 102000, 109200 + own],
    ];
    if (period !== 'month')
      return history
        .slice(period === 'quarter' ? -3 : 0)
        .map(([label, earned, spent]) => ({ label, earned, spent }));
    const spending = [
        16000,
        20000,
        27000,
        32000,
        35000,
        41000,
        47000,
        57000,
        77000,
        84000,
        90000,
        99000,
        109200 + own,
      ],
      earned = [
        28000, 28000, 28000, 28000, 55000, 55000, 55000, 102000, 102000, 102000, 102000, 102000,
        102000,
      ];
    const length = mode === 'home' ? 30 : 13;
    return Array.from({ length }, (_, i) => ({
      label: 'Nov ' + (i + 1),
      earned: i < 13 ? earned[i] : i < 14 ? 102000 : 224000,
      spent: i < 13 ? spending[i] : Math.round(109200 + own + ((175800 - 109200) * (i - 12)) / 17),
      projected: i > 12,
    }));
  }
  function chartTotal(period) {
    const data = periodData(period);
    if (period === 'month') return data.at(-1);
    return {
      earned: data.reduce((a, d) => a + d.earned, 0),
      spent: data.reduce((a, d) => a + d.spent, 0),
    };
  }
  function moneyChart(id, period = 'month', mode = 'profile') {
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
      data = periodData(period, mode),
      max = Math.max(...data.flatMap((d) => [d.earned, d.spent])),
      ceiling = Math.ceil(max / 60000) * 60000;
    const x = (i) => left + (i / (data.length - 1)) * plot,
      y = (c) => bottom - (c / ceiling) * (bottom - top),
      path = (key, ds, offset = 0) =>
        ds
          .map((d, i) => `${i ? 'L' : 'M'}${x(i + offset).toFixed(1)} ${y(d[key]).toFixed(1)}`)
          .join('');
    chartRegistry[id] = { data, width, left, right, top, bottom, ceiling, x, y, mode };
    const ticks =
      width < 430
        ? [0, Math.floor((data.length - 1) / 2), data.length - 1]
        : [
            0,
            Math.round((data.length - 1) / 4),
            Math.round((data.length - 1) / 2),
            Math.round((data.length - 1) * 0.75),
            data.length - 1,
          ];
    return `<div class="interactive-chart" data-chart-id="${id}"><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Interactive ${mode === 'home' ? 'November actual and projected' : 'income versus spending'} chart. Drag or use the date slider to inspect values."><title>Income and spending in USD</title><g>${[
      3,
    ]
      .map((i) => {
        const v = (i * ceiling) / 3;
        return `<path d="M${left} ${y(v)}H${width - right}" stroke="var(--sp-line)" stroke-width="1"/><text x="0" y="${y(v) + 4}">${v >= 100000 ? '$' + (v / 100000).toFixed(1) + 'k' : dollarLabel(Math.round(v))}</text>`;
      })
      .join(
        '',
      )}${ticks.map((i) => `<text x="${x(i)}" y="207" text-anchor="${i === data.length - 1 ? 'end' : i === 0 ? 'start' : 'middle'}">${data[i].label.replace(mode === 'home' ? 'Nov ' : '', '')}</text>`).join('')}</g>${[
      'earned',
      'spent',
    ]
      .map((key) => {
        const color = key === 'earned' ? 'var(--sp-income)' : 'var(--sp-spend)';
        return `<g data-series="${key}" ${chartVisibility[key] ? '' : 'opacity="0"'}><path d="${path(key, mode === 'home' ? data.slice(0, 13) : data)}" fill="none" stroke="${color}" stroke-width="2.7" stroke-linejoin="round"/>${mode === 'home' ? `<path d="${path(key, data.slice(12), 12)}" fill="none" stroke="${color}" stroke-width="2" stroke-dasharray="5 5"/><text x="${width - right + 7}" y="${y(data.at(-1)[key]) + 4}" style="fill:${color};font-weight:600">${dollarLabel(data.at(-1)[key])}</text>` : ''}<circle data-hover-marker="${key}" cx="${x(0)}" cy="${y(data[0][key])}" r="4" fill="${color}" opacity="0"/></g>`;
      })
      .join(
        '',
      )}<line data-guide x1="${left}" x2="${left}" y1="${top}" y2="${bottom}" stroke="var(--sp-muted)" stroke-width="1" stroke-dasharray="3 4" opacity="0"/><rect data-hit x="${left}" y="${top}" width="${plot}" height="${bottom - top}" fill="transparent"/></svg><div class="chart-readout" data-readout aria-live="off"><span class="muted">${mode === 'home' ? 'Explore the month →' : 'Inspect a point →'}</span><span>Earned <strong>${dollarLabel(data[mode === 'home' ? 12 : data.length - 1].earned)}</strong></span><span>Spent <strong>${dollarLabel(data[mode === 'home' ? 12 : data.length - 1].spent)}</strong></span></div></div>`;
  }
  function chart() {
    return moneyChart('home-flow', 'month', 'home');
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
      `<strong>${esc(label)}${between ? ' · between recorded points' : d.projected ? ' · projected' : ''}</strong>${[
        'earned',
        'spent',
      ]
        .filter((k) => chartVisibility[k])
        .map(
          (k) =>
            `<span>${k === 'earned' ? 'Earned' : 'Spent'} <strong>${dollarLabel(values[k])}</strong></span>`,
        )
        .join('')}`;
    if (announceResult)
      announce(
        `${d.label}${d.projected ? ', projected' : ''}. Earned ${money(values.earned)}, spent ${money(values.spent)}.`,
      );
  }
  function chartControls(id, period = 'month', mode = 'profile') {
    return `<div>${['earned', 'spent'].map((k) => `<button type="button" class="chart-toggle cursor-interaction" data-toggle-series="${k}" aria-pressed="${chartVisibility[k]}"><span class="chart-swatch ${k}"></span>${k === 'earned' ? 'Earned' : 'Spent'}</button>`).join('')}</div><div class="chart-range"><label for="${id}-range">${mode === 'home' ? 'Inspect the month' : 'Inspect ' + (period === 'month' ? 'a day' : 'a month')}</label><input type="range" id="${id}-range" data-chart-range="${id}" min="0" max="${periodData(period, mode).length - 1}" step="1" value="${mode === 'home' ? 12 : periodData(period, mode).length - 1}" aria-label="Inspect ${id === 'home-flow' ? 'overview' : 'profile'} chart date"></div>`;
  }
  function profile() {
    return `<div class="profile-head"><span class="avatar profile-avatar">MC</span><div><div class="eyebrow muted" style="margin-bottom:6px">Your profile</div><h1>Maya, in the details.</h1><p>Your spending habits, plans, and recurring little things.</p></div><span class="tag">${icon('calendar-days')}Nov 13, 2026</span></div><div class="profile-toolbar"><div class="profile-nav" aria-label="Profile detail sections">${[
      ['spending', 'Spending'],
      ['recurring', 'Recurring'],
      ['upcoming', 'Coming up'],
    ]
      .map(
        ([v, t]) =>
          `<button type="button" class="profile-subtab cursor-interaction" data-profile-tab="${v}" aria-pressed="${state.profileTab === v}">${t}</button>`,
      )
      .join('')}</div>${
      state.profileTab === 'spending'
        ? `<div class="period-picker" aria-label="Cash flow period">${[
            ['month', 'Nov 1–13'],
            ['quarter', '3 months'],
            ['half', '6 months'],
          ]
            .map(
              ([v, t]) =>
                `<button type="button" data-period="${v}" aria-pressed="${state.period === v}" class="cursor-interaction">${t}</button>`,
            )
            .join('')}</div>`
        : ''
    }</div>${state.profileTab === 'spending' ? profileSpending() : state.profileTab === 'recurring' ? profileRecurring() : profileUpcoming()}`;
  }
  function profileSpending() {
    const totals = chartTotal(state.period),
      net = totals.earned - totals.spent,
      rows = spendingRows(),
      out = rows.reduce((a, r) => a + r.cents, 0),
      cats = ['Food & drink', 'Home & bills', 'Getting around', 'Just for fun', 'Other'];
    const filtered =
      state.category === 'all' ? rows : rows.filter((r) => r.category === state.category);
    return `<div class="profile-totals"><div class="profile-total"><span class="small">${icon('arrow-down-left')}Money in</span><div class="display money">${dollarLabel(totals.earned)}</div></div><div class="profile-total"><span class="small">${icon('arrow-up-right')}Your spending</span><div class="display money">${dollarLabel(totals.spent)}</div></div><div class="profile-total"><span class="small">Deposits minus spending</span><div class="display money">${net < 0 ? '−' : '+'}${dollarLabel(Math.abs(net))}</div></div></div><section class="analytics-sheet" aria-label="Detailed cash flow"><div class="section-head"><h2>How it’s been flowing</h2><span class="small muted">USD</span></div>${moneyChart('profile-flow', state.period)}${chartControls('profile-flow', state.period)}<p class="small muted" style="margin-top:10px">${state.period === 'month' ? 'Actual cumulative transactions, Nov 1–13.' : 'Monthly totals. November includes only Nov 1–13.'} Shared expenses count only your share.</p></section><div class="section-head"><h2>A closer look at November</h2><span class="small muted">Nov 1–13</span></div><div class="profile-columns"><section aria-label="Interactive spending categories"><div class="section-head" style="margin-bottom:5px"><h3>Where it went</h3><button type="button" class="text-button cursor-interaction" data-category="all">${state.category === 'all' ? 'Choose a category' : 'Clear filter'}</button></div>${cats
      .map((cat) => {
        const c = rows.filter((r) => r.category === cat).reduce((a, r) => a + r.cents, 0);
        return `<button type="button" class="category-choice cursor-interaction" data-category="${cat}" aria-pressed="${state.category === 'all' || state.category === cat}" aria-label="Filter ${cat}, ${money(c)}, ${Math.round((c / out) * 100)} percent of spending"><span class="math-line"><span>${cat}</span><span class="money">${dollarLabel(c)} <span class="muted">· ${Math.round((c / out) * 100)}%</span></span></span><span class="category-track"><span style="width:${(c / out) * 100}%"></span></span></button>`;
      })
      .join(
        '',
      )}<p class="small muted" style="margin-top:8px">Select a bar to see the merchants below.</p></section><section aria-label="Payment methods"><h3 style="margin-bottom:10px">How you paid</h3>${[
      ['Bank transfer', 'landmark'],
      ['Card', 'credit-card'],
      ['Contactless', 'nfc'],
      ['Cash', 'banknote'],
    ]
      .map(([method, sym]) => {
        const c = rows.filter((r) => r.method === method).reduce((a, r) => a + r.cents, 0);
        return `<div class="payment-row">${icon(sym)}<span>${method}</span><strong class="money">${dollarLabel(c)}</strong></div>`;
      })
      .join(
        '',
      )}<div class="insight" style="margin-top:17px">${icon('repeat-2')}<div><div class="insight-label">The regulars</div><p>6 recurring costs. ${money(93998)} expected over the next 30 days, including your rent share.</p><button type="button" class="cursor-interaction" data-profile-tab="recurring">Look at the recurring stuff</button></div></div></section></div><section class="merchant-ledger" aria-label="Merchant spending detail"><div class="section-head"><h2>${state.category === 'all' ? 'The places behind the numbers' : esc(state.category)}</h2><span class="small muted">${filtered.length} merchants</span></div><div aria-live="polite">${filtered
      .sort((a, b) => b.cents - a.cents)
      .map(
        (r) =>
          `<div class="merchant-row"><div><strong>${esc(r.name)}</strong><div class="small">${r.count} ${r.count === 1 ? 'transaction' : 'transactions'} · ${r.category}</div></div><span class="small">${r.method}</span><strong class="money">${money(r.cents)}</strong></div>`,
      )
      .join('')}</div></section>`;
  }
  function billRows(list) {
    return list
      .map(
        (b) =>
          `<div class="bill-row"><span class="bill-symbol">${icon(b.icon)}</span><div class="bill-copy"><strong>${b.name}</strong><div class="small">${b.note}<br>Nov ${b.day} · ${b.method}</div></div><div class="bill-amount"><strong class="money">${money(b.amount)}</strong><div class="small">${b.estimate ? 'Estimated' : 'Monthly'}</div></div><button type="button" class="text-button cursor-interaction" data-bill="${b.name}" aria-label="Review ${b.name}">${icon('chevron-right')}</button></div>`,
      )
      .join('');
  }
  function profileRecurring() {
    return `<div class="bill-summary"><div><div class="eyebrow muted">Expected in the next 30 days</div><div class="display money">$939.98</div><p class="small muted">6 recurring costs · includes estimated utilities</p></div><span class="tag">${icon('repeat-2')}Monthly rhythm</span></div><div class="section-head"><h2>The regulars</h2><span class="small muted">Next due date</span></div>${billRows(bills)}<div class="goal-note">${icon('info')}<span>These are expected costs, not pending transfers. Changes to subscriptions are made with the provider.</span></div>`;
  }
  function profileUpcoming() {
    return `<div class="bill-summary"><div><div class="eyebrow muted">Due before payday</div><div class="display money">$860.00</div><p class="small muted">Covered by the $${(1248 - (state.logged ? demo.draft.cents / 100 : 0) - (state.settled ? 18 : 0)).toFixed(2)} in your spending account.</p></div><span class="tag">${icon('calendar-clock')}Next payday · Nov 15</span></div><div class="upcoming-day"><span class="date-tile">NOV<strong>14</strong></span><div><h3>Home comes first</h3><p class="small muted">2 expected costs · $860.00</p></div></div>${billRows(bills.filter((b) => b.day === 14))}<div class="future-inflow">${icon('arrow-down-left')}<div><strong>Nov 15 · Paycheck expected</strong><div class="small muted">+$1,220.00 · Based on your regular deposits</div></div></div><div class="section-head" style="margin-top:24px"><h2>After payday</h2><span class="small muted">$79.98 expected</span></div>${billRows(bills.filter((b) => b.day > 15))}<div class="goal-note">${icon('calendar-days')}<span>Dates and amounts are estimates from your regular bills. Your balance changes only when transactions are recorded.</span></div>`;
  }
  function billDetail(name) {
    const b = bills.find((i) => i.name === name);
    if (!b) return;
    openModal(
      'Recurring cost details',
      `<div class="modal-header"><div><div class="eyebrow">Recurring cost</div><h2>${b.name}</h2></div>${closeButton}</div><div class="amount-large display money">${money(b.amount)}</div><div class="detail-row"><span class="muted">Next expected</span><strong>November ${b.day}, 2026</strong></div><div class="detail-row"><span class="muted">Repeats</span><span>Monthly</span></div><div class="detail-row"><span class="muted">Payment method</span><span>${b.method}</span></div><div class="detail-row"><span class="muted">Amount</span><span>${b.estimate ? 'Estimate based on recent bills' : 'Expected recurring amount'}</span></div><p style="margin-top:17px">${b.note}. This is a forecast for planning, not a payment request.</p><div class="modal-actions"><button type="button" class="primary cursor-interaction" data-action="close">Got it</button></div>`,
    );
  }
  function mountMoneyCharts() {
    root.querySelectorAll('[data-chart-id]').forEach((el) => {
      const id = el.dataset.chartId;
      showChartPoint(el, id === 'home-flow' ? 12 / 29 : 1);
    });
  }
  root.addEventListener('pointermove', (e) => {
    const el = e.target.closest('[data-chart-id]');
    if (!el) return;
    const c = chartRegistry[el.dataset.chartId],
      r = el.querySelector('svg').getBoundingClientRect(),
      fraction =
        (((e.clientX - r.left) / r.width) * c.width - c.left) / (c.width - c.left - c.right);
    showChartPoint(el, fraction);
  });
  root.addEventListener('pointerdown', (e) => {
    const el = e.target.closest('[data-chart-id]');
    if (el) {
      const c = chartRegistry[el.dataset.chartId],
        r = el.querySelector('svg').getBoundingClientRect();
      showChartPoint(
        el,
        (((e.clientX - r.left) / r.width) * c.width - c.left) / (c.width - c.left - c.right),
        true,
      );
    }
  });
  root.addEventListener('input', (e) => {
    if (e.target.dataset.chartRange) {
      const el = root.querySelector(`[data-chart-id="${e.target.dataset.chartRange}"]`);
      showChartPoint(el, Number(e.target.value) / Number(e.target.max), true);
    }
  });
  root.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.profileTab) {
      state.page = 'profile';
      state.profileTab = b.dataset.profileTab;
      render();
      persist();
    }
    if (b.dataset.period) {
      state.period = b.dataset.period;
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
      root
        .querySelectorAll(`[data-series="${k}"]`)
        .forEach((n) => n.setAttribute('opacity', chartVisibility[k] ? '1' : '0'));
      root
        .querySelectorAll(`[data-toggle-series="${k}"]`)
        .forEach((n) => n.setAttribute('aria-pressed', chartVisibility[k]));
      mountMoneyCharts();
    }
  });
  function staticHomeChart() {
    const width = Math.max(240, Math.round(view.getBoundingClientRect().width)),
      height = 218,
      left = 38,
      right = 58,
      top = 26,
      bottom = 184,
      plot = width - left - right;
    const narrow = width < 430,
      earned = 102000,
      spent = 109200 + (state.logged ? shareFor('Maya') : 0),
      projected = 175800 + (state.logged ? shareFor('Maya') : 0);
    const x = (d) => left + ((d - 1) / 29) * plot,
      y = (c) => bottom - (c / 240000) * (bottom - top),
      fmt = (n) => Math.round(n * 10) / 10;
    const income = [
      [1, 28000],
      [5, 55000],
      [8, 102000],
      [13, 102000],
    ];
    let ep = `M${x(1)} ${y(28000)}`;
    income.slice(1).forEach(([d, v]) => (ep += `H${x(d)}V${y(v)}`));
    const spending = [
      [1, 16000],
      [3, 27000],
      [4, 32000],
      [5, 35000],
      [7, 47000],
      [8, 57000],
      [9, 77000],
      [11, 90000],
      [13, spent],
    ];
    const line = (data) =>
      data.map(([d, v], i) => `${i ? 'L' : 'M'}${fmt(x(d))} ${fmt(y(v))}`).join('');
    const projectedLine = [
      [13, spent],
      [16, 121000],
      [19, 134000],
      [22, 140000],
      [25, 155000],
      [28, 166000],
      [30, projected],
    ];
    const ticks = narrow
      ? [
          [1, 'Nov 1'],
          [13, '13'],
          [30, '30'],
        ]
      : [
          [1, 'Nov 1'],
          [8, '8'],
          [13, '13'],
          [20, '20'],
          [30, '30'],
        ];
    return `<svg class="flow-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="November cumulative money flow. Earned ${money(earned)}, spent ${money(spent)} on November 13. Projected income $2,240, projected spending ${money(projected)} by November 30."><title>Earned and spent this November</title><desc>Solid lines show transactions through November 13. Dashed lines are estimates. A $1,220 paycheck is expected November 15.</desc><g stroke="var(--sp-line)" stroke-width="1">${[0, 80000, 160000, 240000].map((c) => `<path d="M${left} ${y(c)}H${width - right}"/>`).join('')}</g><g>${[
      [0, '$0'],
      [80000, '$800'],
      [160000, '$1.6k'],
      [240000, '$2.4k'],
    ]
      .map(([c, t]) => `<text x="0" y="${y(c) + 4}">${t}</text>`)
      .join(
        '',
      )}${ticks.map(([d, t]) => `<text x="${x(d)}" y="207" text-anchor="${d === 30 ? 'end' : 'start'}">${t}</text>`).join('')}</g><path d="M${x(13)} 23V${bottom}" stroke="var(--sp-muted)" stroke-width="1" stroke-dasharray="2 4" opacity=".6"/><text x="${x(13)}" y="12" text-anchor="middle">Today</text><path d="${ep}" stroke="var(--sp-income)" fill="none" stroke-width="2.5" stroke-linejoin="round"/><path d="${line(spending)}" stroke="var(--sp-spend)" fill="none" stroke-width="2.5" stroke-linejoin="round"/><path d="M${x(13)} ${y(102000)}H${x(15)}V${y(224000)}H${x(30)}" stroke="var(--sp-income)" fill="none" stroke-width="2" stroke-dasharray="5 5"/><path d="${line(projectedLine)}" stroke="var(--sp-spend)" fill="none" stroke-width="2" stroke-dasharray="5 5"/><circle cx="${x(13)}" cy="${y(102000)}" r="3.5" fill="var(--sp-income)"/><circle cx="${x(13)}" cy="${y(spent)}" r="3.5" fill="var(--sp-spend)"/><text x="${width - right + 8}" y="${y(224000) + 4}" class="line-label" style="fill:var(--sp-income)">$2,240</text><text x="${width - right + 8}" y="${y(projected) + 4}" class="line-label" style="fill:var(--sp-spend)">${dollarLabel(projected)}</text>${narrow ? '' : `<text x="${x(15) + 7}" y="${y(224000) - 9}">Payday ↗</text>`}</svg>`;
  }

  function budget(name, spent, total, symbol) {
    let p = Math.min(spent / total, 1);
    return `<button type="button" class="budget-row cursor-interaction" data-category="${name}" aria-label="See ${name} spending details" style="width:100%;text-align:left"><div class="budget-ring"><svg viewBox="0 0 36 36" aria-hidden="true"><circle cx="18" cy="18" r="15" fill="none" stroke="var(--sp-soft)" stroke-width="3"/><circle cx="18" cy="18" r="15" fill="none" stroke="var(--sp-pine)" stroke-width="3" stroke-dasharray="${p * 94.25} 94.25" stroke-linecap="round"/></svg><span class="ring-symbol">${icon(symbol)}</span></div><div class="budget-body"><div class="budget-title"><span>${name}</span><span class="money">${dollarLabel(Math.round(spent * 100))}<span class="muted"> / $${total}</span></span></div><div class="budget-sub">${spent > total ? dollarLabel(Math.round((spent - total) * 100)) + ' over budget' : dollarLabel(Math.round((total - spent) * 100)) + ' left this month'}</div></div></button>`;
  }
  function tx(name, sub, amount, symbol) {
    return `<div class="transaction"><span class="tx-icon">${icon(symbol)}</span><div class="tx-copy"><strong>${name}</strong><span>${sub}</span></div><span class="tx-amount money">${amount}</span></div>`;
  }
  function home() {
    const available = 38800 - (state.logged ? demo.draft.cents : 0) - (state.settled ? 1800 : 0),
      balance = 124800 - (state.logged ? demo.draft.cents : 0) - (state.settled ? 1800 : 0),
      own = state.logged ? shareFor('Maya') : 0;
    return (
      heading(
        'Friday, November 13',
        'Hey Maya. You’ve got room.',
        'A clear look at this month. Then, back to life.',
        `<button type="button" class="primary cursor-interaction" data-go="chat">${icon('plus')}Add an expense</button>`,
      ) +
      `
<div class="balance-strip"><div class="available"><div class="label">Left after upcoming bills ${icon('arrow-up-right')}</div><div class="figure display money">${money(available).split('.')[0]}<span class="cents">.${money(available).split('.')[1]}</span></div><p class="footnote">Your bills are covered. This is the breathing room.</p><span class="smile" aria-hidden="true"></span></div><div class="balance-math"><div class="math-line"><span class="muted">In your account</span><strong class="money">${money(balance)}</strong></div><div class="math-line"><span class="muted">Bills before payday</span><span class="money">− $860.00</span></div><div class="math-line"><span>Yours to plan with</span><span class="money">${money(available)}</span></div></div></div>
<section class="chart-section" aria-label="Monthly money flow"><div class="section-head"><h2>The month so far</h2><span class="month-label">November 2026</span></div><div class="chart-summary"><p><strong class="money">$1,020</strong> earned <span aria-hidden="true">·</span> <strong class="money">${money(109200 + own).replace('.00', '')}</strong> spent</p><span class="forecast">${icon('move-up-right')}On pace to save ${money(48200 - own).replace('.00', '')}</span></div>${chart()}${chartControls('home-flow', 'month', 'home')}<p class="chart-note">Spending counts your share of shared costs. Dashed forecasts include Nov 15 payday and are estimates.</p></section>
<div class="under-chart"><section aria-label="Category budgets"><div class="section-head"><h2>Room for the good stuff</h2></div>${budget('Food & drink', 234 + (['Food & drink', 'Groceries'].includes(demo.draft.category) ? own / 100 : 0), 300, 'utensils')}${budget('Getting around', 48 + (demo.draft.category === 'Getting around' ? own / 100 : 0), 100, 'train-front')}${budget('Just for fun', 92 + (demo.draft.category === 'Just for fun' ? own / 100 : 0), 120, 'ticket')}<div class="insight">${icon('sprout')}<div><div class="insight-label">A thought from Split · AI</div><p>${state.cap ? 'Your $' + state.cap + ' takeout cap is set. A small plan for the rest of November.' : 'Takeout is 40% above your usual. A $60 cap for the rest of November could help keep your savings plan on track.'}</p><button type="button" class="cursor-interaction" data-action="cap">${state.cap ? 'Adjust the cap' : 'Make a small plan'}</button></div></div></section><section aria-label="Shared money"><div class="section-head"><h2>In it together</h2><button type="button" class="text-button cursor-interaction" data-go="groups">All groups ${icon('arrow-up-right')}</button></div><div class="group-peek"><div class="group-title"><span class="group-picture">${icon('house')}</span><div><h3>Puffton 4</h3><span class="small muted">Home, sweet shared home</span></div></div>${stack()}<div class="peek-value display money">${money((state.settled ? 6450 : 4650) + (state.logged ? demo.draft.cents - own : 0))}</div><p class="small muted">you’re owed, after your share</p><div class="peek-foot"><span class="small muted">${state.settled ? 'Your payment is done' : '3 simple transfers'}</span><button type="button" class="text-button cursor-interaction" data-action="puffton">See the split ${icon('arrow-right')}</button></div></div><div class="activity"><div class="section-head" style="margin-bottom:4px"><h3>Recent activity</h3></div>${state.logged ? tx(esc(demo.draft.merchant), 'Today · your share', money(own), 'utensils') : ''}${tx('Campus café', 'Today · Food & drink', '− $4.50', 'coffee')}${state.settled ? tx('Paid Alex', 'Today · Puffton 4', '− $18.00', 'users') : tx('Trader Joe’s', 'Yesterday · Puffton 4', '− $36.50', 'shopping-basket')}</div></section></div>`
    );
  }
  function cap() {
    openModal(
      'Takeout spending cap',
      `<div class="modal-header"><div><div class="eyebrow">A small plan · AI suggestion</div><h2>Keep some room for later.</h2></div>${closeButton}</div><p>You’ve spent $140 on takeout, compared with your usual $100 at this point in the month.</p><form id="sp-cap-form"><label class="field">Takeout cap for the rest of November<input type="number" name="cap" min="0" max="1000" step="1" required value="${state.cap ?? 60}"></label><div class="checks"><div class="check-row">${icon('bell')}We’ll flag it when you reach 80%.</div><div class="check-row">${icon('check')}This is a reminder. It won’t restrict payments.</div></div><div class="modal-actions"><button type="button" class="secondary cursor-interaction" data-action="close">Maybe later</button><button type="submit" class="primary cursor-interaction">Set my cap</button></div></form>`,
    );
  }
  root.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    switch (b.dataset.action) {
      case 'cap':
        cap();
        break;
    }
  });
  function handleOverviewForm(form, fd) {
    if (form.id !== 'sp-cap-form') return;
      state.cap = Number(fd.get('cap'));
      closeModal();
      render();
      persist();
      toast('Your takeout cap is set. You can change it anytime.');
  }

  function observe() {
    let lastChartWidth = 0;
    new ResizeObserver(() => {
      const w = Math.round(view.getBoundingClientRect().width);
      if (w !== lastChartWidth) {
        lastChartWidth = w;
        root.querySelectorAll('[data-chart-id]').forEach((el) => {
          const id = el.dataset.chartId;
          el.outerHTML = moneyChart(
            id,
            id === 'home-flow' ? 'month' : state.period,
            id === 'home-flow' ? 'home' : 'profile',
          );
        });
        mountMoneyCharts();
      }
    }).observe(view);
  }
  function resetCharts() { chartRegistry = {}; }

  return { home, profile, mountMoneyCharts, resetCharts, observe, handleOverviewForm, tx };
}
