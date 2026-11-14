import { apiRequest } from '../../api/session.js';
import { subscribeFinancialChanges } from '../../api/financial-state.js';
import { usdToCents, formatUsdCents } from '../../lib/money.js';
import { createGoalStore, goalPercent } from './store.js';
import { preserveFocus } from '../../lib/focus.js';

const starters = [
  { name: 'Emergency fund', type: 'savings', target: '1000.00', icon: 'shield-check' },
  { name: 'Next adventure', type: 'trip', target: '500.00', icon: 'luggage' },
  { name: 'New wheels', type: 'car', target: '5000.00', icon: 'car-front' },
];

export function createGoals({ root, state, icon, icons, heading, money, dollarLabel, esc, render, persist, openModal, closeModal, closeButton, toast, announce }) {
  const prefs = { motion: true };
  state.goals = [];
  state.activeGoal = null;
  let latestReceipt = '';
  let sceneHost = null;
  let sceneGoalId = null;
  const store = createGoalStore({ request: apiRequest, onChange: () => {
    state.goals = store.state.goals;
    if (!state.goals.some((g) => g.id === state.activeGoal)) state.activeGoal = state.goals[0]?.id ?? null;
    if (state.page === 'goals' && !root.querySelector('#sp-modal-root').children.length) preserveFocus(root, render);
  } });
  subscribeFinancialChanges(() => store.invalidate());
  const seenGoalScenes = new Set();
  let goalPreview = null,
    goalPlaying = false,
    goalPlayFrame = 0,
    sceneAngle = 0.64,
    sceneController = null;
  let contributionTransition = null,
    contributionFrame = 0;
  function motionAllowed() {
    return prefs.motion && !matchMedia('(prefers-reduced-motion: reduce)').matches;
  }
  function animateContribution(controller, from, to) {
    cancelAnimationFrame(contributionFrame);
    if (!motionAllowed() || from === to) {
      controller.update(to);
      return;
    }
    const started = performance.now();
    let last = -1;
    function tick(now) {
      if (state.page !== 'goals' || sceneController !== controller) return;
      const t = Math.min(1, (now - started) / 1300),
        p = Math.round(from + (to - from) * (1 - Math.pow(1 - t, 3)));
      if (p !== last) {
        controller.update(p);
        last = p;
      }
      controller.animate(t * 2);
      if (t < 1) contributionFrame = requestAnimationFrame(tick);
    }
    contributionFrame = requestAnimationFrame(tick);
  }
  const goalTypes = {
    house: {
      label: 'House',
      icon: 'house',
      steps: ['Survey', 'Foundation', 'Framing', 'Finishing', 'Home'],
      titles: [
        'First, a little groundwork.',
        'Something solid to build on.',
        'It’s taking shape.',
        'Making it feel like home.',
        'The keys are yours.',
      ],
      descriptions: [
        'The survey team is mapping your future address. Every good home starts with a plan.',
        'The crew is pouring the foundation. Your small, steady contributions are doing the same.',
        'The frame is going up, beam by beam. You can already see the rooms you’ll make memories in.',
        'Walls, roof, windows. The details are falling into place.',
        'A path to the front door. A place to call your own. This goal is fully funded.',
      ],
    },
    car: {
      label: 'Car',
      icon: 'car-front',
      steps: ['Parked', 'Connected', 'Refueling', 'Almost full', 'Ready'],
      titles: [
        'Parked, with a plan.',
        'A little fuel for the future.',
        'Filling up, little by little.',
        'Almost ready to roll.',
        'Your next chapter has wheels.',
      ],
      descriptions: [
        'Your car is waiting at the pump. Choose an amount that works for your life.',
        'The nozzle is connected. The first part of your plan is in motion.',
        'The fuel gauge is climbing with your savings. No need to race.',
        'A little more in the tank. You’re getting close to your target.',
        'Full tank. Clear road. Your car goal is fully funded.',
      ],
    },
    trip: {
      label: 'Trip',
      icon: 'luggage',
      steps: ['Dreaming', 'Essentials', 'Packing', 'Zipped up', 'Bon voyage'],
      titles: [
        'A good trip starts here.',
        'The essentials are coming along.',
        'Making room for a little adventure.',
        'Packed. Nearly out the door.',
        'Off you go.',
      ],
      descriptions: [
        'A suitcase, a destination, and a little something set aside.',
        'Passport, camera, the little things. Each contribution packs a bit more possibility.',
        'Clothes are folded, plans are forming. There’s space for the memories you’ll bring home.',
        'The bag is closing. Just the last few things to take care of.',
        'Bag zipped. Tickets ready. Your trip goal is fully funded.',
      ],
    },
    savings: {
      label: 'Savings',
      icon: 'piggy-bank',
      steps: ['Starting', 'Small steps', 'Building', 'Growing', 'Saved'],
      titles: [
        'A little saved. A little lighter.',
        'Small things add up.',
        'Look at what you’re building.',
        'Room for whatever comes next.',
        'A full jar. A plan made real.',
      ],
      descriptions: [
        'A peach glass jar, and a little room for future you.',
        'Each coin is a little progress you’ve recorded. There’s no need to rush.',
        'Your jar is filling, one small contribution at a time.',
        'There’s more in your corner now. Keep the pace that works for you.',
        'You’ve reached the savings target you chose. Take a moment to enjoy that.',
      ],
    },
  };
  function activeGoal() {
    return state.goals.find((g) => g.id === state.activeGoal) || state.goals[0];
  }
  function realPercent(g = activeGoal()) {
    return goalPercent(g);
  }
  function scenePercent() {
    return goalPreview === null ? realPercent() : goalPreview;
  }
  function phase(p) {
    return p === 100 ? 4 : p < 20 ? 0 : p < 40 ? 1 : p < 70 ? 2 : 3;
  }
  function history(goalId) {
    if (!store.state.histories.has(goalId) && !store.state.busy) void store.loadHistory(goalId);
    const data = store.state.histories.get(goalId);
    return `<section class="goal-history" aria-label="Savings history"><h2>Savings history</h2><p class="small muted">Reservations within checking. No bank transfer occurs.</p>
      ${data?.error ? `<p role="alert">${esc(data.error)} <button type="button" class="text-button" data-goal-history="${esc(goalId)}">Retry history</button></p>` : ''}
      ${(data?.items || []).length ? `<ul>${data.items.map((m) => `<li><span>${m.kind === 'contribution' ? 'Set aside' : 'Released'} ${formatUsdCents(m.cents)}</span><time datetime="${esc(m.createdAt)}">${esc(new Date(m.createdAt).toLocaleString())}</time></li>`).join('')}</ul>` : data?.status === 'ready' ? '<p>No savings movements yet.</p>' : ''}
      ${data?.status === 'loading' ? '<p role="status">Loading savings history…</p>' : data?.nextCursor ? `<button type="button" class="text-button" data-goal-history="${esc(goalId)}" data-history-more>Older movements</button>` : ''}</section>`;
  }
  function goals() {
    if (store.state.status === 'idle' && !store.state.busy) void store.load();
    const header = heading('Your goals', 'Give the future a little shape.',
      'Goal savings are set aside within your balance.',
      `<div class="goal-header-actions"><button id="sp-goal-new" type="button" class="primary cursor-interaction" data-action="new-goal">${icon('plus')}New goal</button></div>`);
    const receiptNotice = latestReceipt ? `<section class="sp-card goal-receipt" role="status" aria-label="Last savings action"><strong>Last savings action</strong><p>${esc(latestReceipt)}</p></section>` : '';
    const status = store.state.status === 'loading' ? '<p role="status">Loading your saved goals…</p>'
      : store.state.error ? `<p role="alert">${esc(store.state.error)} ${state.goals.length ? 'Showing the last confirmed progress.' : ''} <button type="button" class="text-button" data-action="refresh-goals">Try again</button></p>` : '';
    if (!state.goals.length) return header + status + (store.state.status === 'ready' ? `<section class="sp-empty"><h2>What are you saving for?</h2><p>Start with an idea, then choose your own target.</p><div class="goal-starters">${starters.map((starter, index) => `<button type="button" class="sp-card" data-goal-starter="${index}">${icon(starter.icon)}<strong>${esc(starter.name)}</strong><span class="small muted">Choose your target →</span></button>`).join('')}</div></section>` : '');
    const g = activeGoal(),
      t = goalTypes[g.type],
      pct = scenePercent(),
      stage = phase(pct),
      real = realPercent(g);
    return (
      header + receiptNotice + status +
      `<div class="goals-tabs" aria-label="Choose a savings goal">${state.goals.map((item) => `<button type="button" id="sp-goal-tab-${esc(item.id)}" class="goal-tab cursor-interaction" data-goal="${esc(item.id)}" aria-pressed="${item.id === g.id}">${icon(goalTypes[item.type].icon)}<span>${esc(item.name)}</span><span class="goal-tab-percent money">${realPercent(item)}%</span></button>`).join('')}</div><section class="goal-workshop" data-goal-type="${g.type}" aria-label="${esc(g.name)} progress scene"><div class="workshop-top"><button type="button" class="material-tag cursor-interaction" id="sp-goal-rotate" data-action="rotate-goal" aria-label="Turn the 3D scene 45 degrees">${icon('rotate-3d')}Turn the view</button><span id="sp-scene-badge" class="material-tag">${goalPreview === null ? 'Saved progress' : 'Preview only'} · <span id="sp-scene-percent">${pct}%</span></span></div><div class="goal-stage"><div class="diorama" id="sp-diorama" role="img" aria-label="3D ${esc(t.label.toLowerCase())} savings scene, ${pct} percent, ${esc(t.steps[stage])}"><div class="scene-loading">Setting the scene…</div><span class="scene-hint">${icon('move-horizontal')}Drag to turn</span></div><div class="scene-copy"><div class="eyebrow">${esc(g.name)}</div><h2 id="sp-stage-title">${t.titles[stage]}</h2><p id="sp-stage-description">${goalPreview !== null && pct === 100 ? `This is what reaching your target looks like. Your saved amount is still ${dollarLabel(g.saved)}.` : t.descriptions[stage]}</p><span class="stage-counter" id="sp-stage-counter">${icon('hammer')}Milestone ${stage + 1} of 5 · ${t.steps[stage]}</span></div></div><div class="milestones" aria-label="Preview goal milestones">${t.steps.map((name, i) => `<button type="button" data-milestone="${[0, 20, 40, 70, 100][i]}" class="milestone cursor-interaction ${i <= stage ? 'done' : ''} ${i === stage ? 'current' : ''}" aria-label="Preview ${name} milestone at ${[0, 20, 40, 70, 100][i]} percent"><span class="milestone-dot">${i < stage ? '✓' : i + 1}</span><span>${name}</span><small>${[0, 20, 40, 70, 100][i]}%</small></button>`).join('')}</div></section><div class="goal-lower"><section aria-label="Saved toward goal"><h2>${esc(g.name)}</h2><div class="goal-amount display money">${formatUsdCents(g.saved)} <small>of ${formatUsdCents(g.target)}</small></div><p class="small muted">${formatUsdCents(Math.max(0, g.target - g.saved))} to go${g.date ? ' · target ' + new Date(g.date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', year: 'numeric' }) : ' · No target date'}</p><div class="goal-progress" role="progressbar" aria-label="Actual savings progress" aria-valuenow="${real}" aria-valuemin="0" aria-valuemax="100"><span style="width:${real}%"></span></div><div class="math-line small"><span>${real}% funded</span><span class="muted">${g.saved >= g.target ? 'You made it.' : 'One contribution at a time.'}</span></div><div class="goal-actions"><button type="button" class="primary cursor-interaction" id="sp-goal-add" data-action="add-savings">${icon('plus')}Add savings</button><button type="button" class="secondary cursor-interaction" id="sp-goal-withdraw" data-action="withdraw-savings">Withdraw savings</button></div></section><section class="preview-panel" aria-label="Preview the goal animation"><div class="preview-title"><span>Watch your plan come to life</span><span class="preview-badge" id="sp-preview-label">${goalPreview === null ? 'Try a preview' : pct + '% preview'}</span></div><label for="sp-goal-preview" class="sr-only">Preview progress percentage without changing savings</label><input id="sp-goal-preview" type="range" min="0" max="100" value="${pct}" step="1" aria-valuetext="${pct} percent preview"><p>Slide through the milestones. This only changes the scene, never your saved amount.</p><div class="preview-buttons"><button type="button" class="text-button cursor-interaction" id="sp-goal-play" data-action="play-goal">${icon(g.type === 'savings' ? 'hand-coins' : 'play')}${g.type === 'savings' ? 'Watch a coin go in' : 'Play the whole story'}</button><button type="button" class="text-button cursor-interaction" id="sp-goal-reset" data-action="reset-goal">${icon('rotate-ccw')}Back to my ${real}%</button></div></section></div><div class="goal-note">${icon('shield-check')}<span>Goal savings reserve part of your spendable funds. Withdrawing releases that reservation. No money is transferred.</span></div>${history(g.id)}`
    );
  }
  function updateGoalScene(p) {
    cancelAnimationFrame(contributionFrame);
    goalPreview = p;
    const g = activeGoal(),
      t = goalTypes[g.type],
      stage = phase(p),
      previousStage = phase(Number(root.querySelector('#sp-goal-preview')?.value ?? p));
    root.querySelector('#sp-scene-percent').textContent = p + '%';
    root.querySelector('#sp-scene-badge').innerHTML =
      `${goalPreview === null ? 'Saved progress' : 'Preview only'} · <span id="sp-scene-percent">${p}%</span>`;
    root.querySelector('#sp-stage-title').textContent = t.titles[stage];
    root.querySelector('#sp-stage-description').textContent =
      p === 100
        ? `This is what reaching your target looks like. Your saved amount is still ${dollarLabel(g.saved)}.`
        : t.descriptions[stage];
    root.querySelector('#sp-stage-counter').innerHTML =
      `${icon('hammer')}Milestone ${stage + 1} of 5 · ${t.steps[stage]}`;
    root.querySelector('#sp-preview-label').textContent = p + '% preview';
    root.querySelector('#sp-goal-preview').value = p;
    root.querySelector('#sp-goal-preview').setAttribute('aria-valuetext', p + ' percent preview');
    root.querySelectorAll('.milestone').forEach((n, i) => {
      n.classList.toggle('done', i <= stage);
      n.classList.toggle('current', i === stage);
      n.querySelector('.milestone-dot').textContent = i < stage ? '✓' : i + 1;
    });
    root
      .querySelector('#sp-diorama')
      ?.setAttribute('aria-label', `3D ${t.label} savings scene, ${p} percent, ${t.steps[stage]}`);
    sceneController?.update(p);
    if (stage !== previousStage && motionAllowed())
      root.querySelector('.scene-copy')?.animate(
        [
          { transform: 'translateY(5px)', opacity: 0.6 },
          { transform: 'translateY(0)', opacity: 1 },
        ],
        { duration: 260, easing: 'cubic-bezier(.22,1,.36,1)' },
      );
    icons();
  }
  function stopGoalPlay() {
    cancelAnimationFrame(goalPlayFrame);
    goalPlaying = false;
  }
  function playGoal() {
    stopGoalPlay();
    if (activeGoal().type === 'savings') {
      sceneController?.deposit();
      announce('Savings coin animation. Saved amounts stay unchanged.');
      return;
    }
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches || !prefs.motion;
    if (reduced) {
      updateGoalScene(100);
      announce('Previewing the complete goal. Savings unchanged.');
      return;
    }
    goalPlaying = true;
    const start = performance.now();
    let last = -1;
    function tick(now) {
      if (state.page !== 'goals') {
        stopGoalPlay();
        return;
      }
      const p = Math.min(100, Math.floor((now - start) / 85));
      if (p !== last) {
        updateGoalScene(p);
        last = p;
      }
      sceneController?.animate((now - start) / 1000);
      if (p < 100) goalPlayFrame = requestAnimationFrame(tick);
      else {
        goalPlaying = false;
        announce('Story preview complete. Your savings are unchanged.');
      }
    }
    goalPlayFrame = requestAnimationFrame(tick);
  }
  function goalForm(starter) {
    openModal('New savings goal', `<div class="modal-header"><div><div class="eyebrow">Something worth saving for</div><h2>What’s on your horizon?</h2></div>${closeButton}</div>
      <form id="sp-goal-form"><fieldset class="goal-form-fields"><label class="field">Goal type<select name="type">${Object.entries(goalTypes).map(([key, value]) => `<option value="${key}">${value.label}</option>`).join('')}</select></label>
      <label class="field">Give it a name<input name="name" required maxlength="45" placeholder="Emergency savings"></label>
      <div class="field-grid"><label class="field">Target, USD<input name="target" inputmode="decimal" required placeholder="500.00"></label>
      <label class="field">Initial savings, USD<input name="saved" inputmode="decimal" value="0.00" required></label></div>
      <label class="field">Target date (optional)<input name="date" type="date"></label>
      <p>Initial savings reserve money from your spendable funds. Savings may exceed the target.</p>
      <p role="alert"></p><p role="status" data-goal-save-status></p><div class="modal-actions"><button type="button" class="secondary" data-action="close">Cancel</button><button type="submit" class="primary">Create goal</button></div></fieldset></form>`);
    if (starter) {
      const form = root.querySelector('#sp-goal-form');
      form.elements.type.value = starter.type; form.elements.name.value = starter.name; form.elements.target.value = starter.target;
      form.elements.target.focus();
    }
  }
  function savingsForm(kind) {
    const g = activeGoal();
    if (!g) return;
    const withdrawal = kind === 'withdrawal';
    openModal(withdrawal ? 'Withdraw savings' : 'Add savings', `<div class="modal-header"><div><div class="eyebrow">${esc(g.name)}</div><h2>${withdrawal ? 'Make room for today.' : 'Another little step.'}</h2></div>${closeButton}</div>
      <p>${withdrawal ? 'Release money reserved by this goal back to your spendable funds.' : 'Reserve part of your spendable funds for this goal.'} No money is transferred.</p>
      <form id="sp-savings-form" data-goal-id="${esc(g.id)}" data-kind="${kind}"><fieldset class="goal-form-fields"><label class="field">Amount, USD<input name="amount" inputmode="decimal" required placeholder="50.00"></label>
      <div class="detail-row"><span>Currently saved</span><strong>${formatUsdCents(g.saved)}</strong></div><p role="alert"></p><p role="status" data-goal-save-status></p>
      <div class="modal-actions"><button type="button" class="secondary" data-action="close">Cancel</button><button type="submit" class="primary">${withdrawal ? 'Withdraw savings' : 'Add savings'}</button></div></fieldset></form>`);
  }
  root.addEventListener('input', (e) => {
    if (e.target.id === 'sp-goal-preview') {
      stopGoalPlay();
      updateGoalScene(Number(e.target.value));
    }
  });
  root.addEventListener('click', (event) => {
    const button = event.target.closest('[data-goal-history]');
    if (button) void store.loadHistory(button.dataset.goalHistory, button.hasAttribute('data-history-more'));
  });
  root.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.goalStarter !== undefined) {
      const starter = starters[Number(b.dataset.goalStarter)];
      if (starter) goalForm(starter);
      return;
    }
    if (b.dataset.goal) {
      stopGoalPlay();
      state.activeGoal = b.dataset.goal;
      goalPreview = null;
      preserveFocus(root, render);
      persist();
    }
    if (b.dataset.milestone !== undefined) {
      stopGoalPlay();
      updateGoalScene(Number(b.dataset.milestone));
    }
    switch (b.dataset.action) {
      case 'rotate-goal':
        sceneController?.rotate();
        break;
      case 'new-goal':
        goalForm();
        break;
      case 'refresh-goals':
        store.invalidate();
        break;
      case 'withdraw-savings':
        savingsForm('withdrawal');
        break;
      case 'add-savings':
        savingsForm('contribution');
        break;
      case 'play-goal':
        playGoal();
        break;
      case 'reset-goal':
        stopGoalPlay();
        goalPreview = null;
        preserveFocus(root, render);
        break;
    }
  });
  async function submitGoalForm(form, fd) {
    if (store.state.busy) return;
    const button = form.querySelector('button[type="submit"]');
    const fieldset = form.querySelector('fieldset');
    const error = form.querySelector('[role="alert"]');
    const status = form.querySelector('[data-goal-save-status]');
    error.textContent = '';
    let payload;
    let path;
    try {
      if (form.id === 'sp-goal-form') {
        payload = { name: String(fd.get('name')).trim(), type: String(fd.get('type')),
          targetCents: usdToCents(String(fd.get('target')).trim()),
          initialCents: usdToCents(String(fd.get('saved')).trim(), { allowZero: true }), targetDate: fd.get('date') || null };
        path = '/api/goals';
      } else {
        payload = { kind: form.dataset.kind, cents: usdToCents(String(fd.get('amount')).trim()) };
        path = `/api/goals/${encodeURIComponent(form.dataset.goalId)}/movements`;
      }
      const fingerprint = JSON.stringify(payload);
      if (form.dataset.fingerprint !== fingerprint) {
        form.dataset.requestKey = crypto.randomUUID();
        form.dataset.fingerprint = fingerprint;
      }
      const previous = state.goals.find((g) => g.id === form.dataset.goalId);
      const from = previous ? realPercent(previous) : 0;
      button.disabled = true; fieldset.disabled = true; form.setAttribute('aria-busy', 'true');
      status.textContent = 'Saving goal…';
      announce('Saving goal.');
      const result = await store.save(path, { ...payload, requestKey: form.dataset.requestKey });
      if (!result) return;
      const { receipt, firstReceipt } = result;
      const current = state.goals.find((g) => g.id === receipt.goal.id);
      if (state.page === 'goals' && (form.isConnected || state.activeGoal === receipt.goal.id)) {
        if (form.isConnected) state.activeGoal = receipt.goal.id;
        goalPreview = null;
        if (current && previous && firstReceipt && from !== realPercent(current)) contributionTransition = { from, to: realPercent(current) };
      }
      latestReceipt = receipt.movement ? receipt.movement.kind === 'withdrawal'
        ? `Released ${formatUsdCents(receipt.movement.cents)} from ${receipt.goal.name}. It is spendable in checking again.`
        : `Set aside ${formatUsdCents(receipt.movement.cents)} for ${receipt.goal.name}. It stays in checking but isn't spendable.`
        : 'Goal created. No money was set aside.';
      const returnFocus = form.isConnected;
      if (returnFocus) closeModal();
      if (state.page === 'goals') {
        render();
        if (returnFocus) root.querySelector(`[data-action="${form.id === 'sp-goal-form' ? 'new-goal' : payload.kind === 'withdrawal' ? 'withdraw-savings' : 'add-savings'}"]`)?.focus({ preventScroll: true });
      }
      toast(latestReceipt);
    } catch (failure) {
      error.textContent = failure.message || 'Your goal could not be saved. Try again.';
      announce(error.textContent);
    } finally {
      button.disabled = false; fieldset.disabled = false; form.removeAttribute('aria-busy');
      status.textContent = '';
    }
  }
  function handleGoalForm(form, fd) {
    if (!['sp-goal-form', 'sp-savings-form'].includes(form.id)) return false;
    void submitGoalForm(form, fd);
    return true;
  }

  let threeLib = null,
    threeLoading = null;
  function loadThree() {
    if (threeLib) return Promise.resolve(threeLib);
    if (!threeLoading)
      threeLoading = import('three').then((m) => {
        threeLib = m;
        return m;
      });
    return threeLoading;
  }
  async function mountGoalScene() {
    const host = root.querySelector('#sp-diorama');
    if (!host) return;
    const goal = activeGoal();
    const transition = contributionTransition;
    contributionTransition = null;
    function applyTransition(controller) {
      if (!transition) return;
      if (goal.type === 'savings' && transition.to > transition.from && motionAllowed()) {
        if (!controller.deposit(() => controller.update(transition.to))) controller.update(transition.to);
      } else animateContribution(controller, transition.from, transition.to);
    }
    if (sceneController && sceneHost && sceneGoalId === goal.id) {
      sceneHost.setAttribute('aria-label', host.getAttribute('aria-label'));
      host.replaceWith(sceneHost);
      sceneController.settleTo(transition ? transition.from : scenePercent());
      applyTransition(sceneController);
      return;
    }
    try {
      const T = await loadThree();
      if (!host.isConnected || state.page !== 'goals') return;
      const firstOpen = !seenGoalScenes.has(goal.id);
      seenGoalScenes.add(goal.id);
      sceneController = createDiorama(
        T,
        host,
        goal.type,
        transition && motionAllowed() ? transition.from : scenePercent(),
        firstOpen,
      );
      sceneHost = host;
      sceneGoalId = goal.id;
      applyTransition(sceneController);
    } catch (e) {
      if (host.isConnected) {
        const loading = host.querySelector('.scene-loading');
        if (loading) loading.textContent = 'The 3D scene couldn’t load. Your progress is still shown below.';
      }
    }
  }
  function createDiorama(T, host, type, pct, firstOpen = false) {
    const renderer = new T.WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: 'low-power',
    });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = T.PCFSoftShadowMap;
    renderer.outputColorSpace = T.SRGBColorSpace;
    renderer.toneMapping = T.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    const scene = new T.Scene(),
      camera = new T.OrthographicCamera(-4.2, 4.2, 3.1, -3.1, 0.1, 50);
    let model = new T.Group(),
      workers = [],
      current = pct;
    const stageRoot = new T.Group(),
      world = new T.Group();
    stageRoot.add(world);
    scene.add(stageRoot);
    const meshKeys = new Map();
    scene.add(new T.HemisphereLight('#f7fff5', '#778370', 2.6));
    const light = new T.DirectionalLight('#fff8e6', 4.2);
    light.position.set(-3, 8, 6);
    light.castShadow = true;
    light.shadow.mapSize.set(1024, 1024);
    Object.assign(light.shadow.camera, {
      left: -5,
      right: 5,
      top: 5,
      bottom: -5,
      near: 0.5,
      far: 20,
    });
    light.shadow.normalBias = 0.025;
    light.shadow.bias = -0.0003;
    light.shadow.radius = 4;
    scene.add(light);
    const fill = new T.DirectionalLight('#dbe9ff', 1.2);
    fill.position.set(5, 4, -4);
    scene.add(fill);
    const shadow = new T.Mesh(
      new T.PlaneGeometry(200, 200),
      new T.ShadowMaterial({ opacity: 0.14 }),
    );
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = -0.14;
    shadow.receiveShadow = true;
    scene.add(shadow);
    host.querySelector('.scene-loading')?.remove();
    host.prepend(renderer.domElement);
    renderer.domElement.setAttribute('aria-hidden', 'true');
    host.dataset.sceneReady = 'true';
    const mat = (color, extra = {}) =>
      new T.MeshStandardMaterial({ color, roughness: 0.72, metalness: 0.02, ...extra });
    function add(geom, color, x, y, z, parent = model, extra = {}) {
      const m = new T.Mesh(geom, mat(color, extra));
      m.position.set(x, y, z);
      const parentKey =
        parent === model
          ? 'root'
          : parent.userData.kind ||
            'group:' + parent.position.x.toFixed(2) + ':' + parent.position.z.toFixed(2);
      const stem = [geom.type, color, x.toFixed(3), z.toFixed(3), parentKey].join('|'),
        count = meshKeys.get(stem) || 0;
      meshKeys.set(stem, count + 1);
      m.userData.stableKey = stem + '|' + count;
      m.userData.actor = Boolean(parent.userData.actor);
      m.castShadow = true;
      m.receiveShadow = true;
      parent.add(m);
      return m;
    }
    function roundedGeometry(w, h, d, r) {
      r = Math.min(r, w / 4, h / 4, d / 4);
      const a = w / 2 - r,
        b = h / 2 - r,
        shape = new T.Shape();
      shape.moveTo(-a + r, -b);
      shape.lineTo(a - r, -b);
      shape.quadraticCurveTo(a, -b, a, -b + r);
      shape.lineTo(a, b - r);
      shape.quadraticCurveTo(a, b, a - r, b);
      shape.lineTo(-a + r, b);
      shape.quadraticCurveTo(-a, b, -a, b - r);
      shape.lineTo(-a, -b + r);
      shape.quadraticCurveTo(-a, -b, -a + r, -b);
      const geo = new T.ExtrudeGeometry(shape, {
        depth: d - 2 * r,
        bevelEnabled: true,
        bevelSegments: 2,
        steps: 1,
        bevelSize: r,
        bevelThickness: r,
        curveSegments: 4,
      });
      geo.translate(0, 0, -d / 2 + r);
      return geo;
    }
    function box(w, h, d, color, x, y, z, r = 0.035, parent = model) {
      return add(
        r ? roundedGeometry(w, h, d, r) : new T.BoxGeometry(w, h, d),
        color,
        x,
        y,
        z,
        parent,
      );
    }
    function sphere(r, color, x, y, z, parent = model, sx = 1, sy = 1, sz = 1) {
      const m = add(new T.SphereGeometry(r, 24, 16), color, x, y, z, parent);
      m.scale.set(sx, sy, sz);
      return m;
    }
    function cyl(r, h, color, x, y, z, parent = model, r2 = r) {
      return add(new T.CylinderGeometry(r2, r, h, 32), color, x, y, z, parent);
    }
    function beam(a, b, r, color, parent = model) {
      const av = new T.Vector3(...a),
        bv = new T.Vector3(...b),
        v = bv.clone().sub(av),
        m = add(
          new T.CylinderGeometry(r, r, v.length(), 10),
          color,
          ...av.clone().add(bv).multiplyScalar(0.5).toArray(),
          parent,
        );
      m.quaternion.setFromUnitVectors(new T.Vector3(0, 1, 0), v.normalize());
      return m;
    }
    function tree(x, z, size = 1) {
      cyl(0.09, 0.9, '#96734d', x, 0.65, z);
      sphere(0.66, '#6d955b', x, 1.35, z, model, size, 1.2 * size, size);
      sphere(0.47, '#87aa6b', x - 0.3, 1.58, z + 0.08, model, size, size, size);
    }
    function person(x, z, rotation = 0, hardhat = true) {
      const g = new T.Group();
      g.position.set(x, 0.18, z);
      g.rotation.y = rotation;
      g.userData.kind = 'person:' + x + ':' + z;
      g.userData.actor = true;
      model.add(g);
      box(0.1, 0.26, 0.12, '#294354', -0.075, 0.16, 0, 0.025, g);
      box(0.1, 0.26, 0.12, '#294354', 0.075, 0.16, 0, 0.025, g);
      box(0.13, 0.065, 0.2, '#24312b', -0.075, 0.04, 0.025, 0.02, g);
      box(0.13, 0.065, 0.2, '#24312b', 0.075, 0.04, 0.025, 0.02, g);
      box(0.27, 0.28, 0.16, hardhat ? '#f6ad44' : '#356f79', 0, 0.41, 0, 0.06, g);
      box(0.025, 0.23, 0.175, '#f8e79e', -0.07, 0.41, 0, 0.005, g);
      box(0.025, 0.23, 0.175, '#f8e79e', 0.07, 0.41, 0, 0.005, g);
      sphere(0.115, '#c89371', 0, 0.66, 0, g);
      if (hardhat) {
        const hat = sphere(0.135, '#ffd658', 0, 0.735, 0, g, 1, 0.6, 1);
        cyl(0.16, 0.035, '#f2bd36', 0, 0.71, 0, g);
      }
      const arm1 = box(0.085, 0.23, 0.09, '#edac72', -0.18, 0.4, 0.025, 0.03, g);
      arm1.rotation.z = -0.3;
      const arm2 = box(0.085, 0.23, 0.09, '#edac72', 0.18, 0.4, 0.025, 0.03, g);
      arm2.rotation.z = 0.3;
      workers.push({
        g,
        baseX: x,
        baseZ: z,
        arms: [arm1, arm2],
        legs: [g.children[0], g.children[1]],
      });
      return g;
    }
    function plankPath() {
      for (let i = 0; i < 4; i++)
        box(0.72, 0.055, 0.28, '#d7d9ce', 0.2, 0.19, 1.3 + i * 0.37, 0.04);
    }
    function platform(color = '#DCC8A8') {
      box(6.1, 0.23, 4.8, '#B89A74', 0, 0, 0, 0.15);
      box(6.05, 0.08, 4.75, color, 0, 0.15, 0, 0.09);
    }
    function roof() {
      const shape = new T.Shape();
      shape.moveTo(-1.62, 0);
      shape.lineTo(0, 0.98);
      shape.lineTo(1.62, 0);
      shape.lineTo(-1.62, 0);
      const front = add(
        new T.ExtrudeGeometry(shape, {
          depth: 2.7,
          bevelEnabled: true,
          bevelSegments: 2,
          bevelSize: 0.025,
          bevelThickness: 0.025,
          steps: 1,
        }),
        '#bc684b',
        -0.1,
        2.07,
        -1.6,
      );
      for (let i = 0; i < 7; i++) {
        const z = -1.58 + i * 0.44;
        beam([-1.72, 2.09, z], [-0.1, 3.07, z], 0.018, '#a3523e');
        beam([-0.1, 3.07, z], [1.52, 2.09, z], 0.018, '#d98760');
      }
      box(0.16, 0.52, 0.25, '#d4c5af', 0.7, 2.94, -0.8, 0.025);
    }
    function homeScene(p) {
      platform();
      const stage = phase(p);
      if (p < 20) {
        box(2.95, 0.018, 2.4, '#b6c4a5', -0.1, 0.22, -0.3, 0.01);
        for (const x of [-1.6, 1.4]) {
          beam([x, 0.24, -1.5], [x, 0.24, 0.9], 0.015, '#f4f5db');
        }
        for (const z of [-1.5, 0.9]) beam([-1.6, 0.24, z], [1.4, 0.24, z], 0.015, '#f4f5db');
        for (const x of [-1.65, 1.45])
          for (const z of [-1.55, 0.95]) {
            cyl(0.025, 0.3, '#b28251', x, 0.35, z);
            box(0.18, 0.11, 0.012, '#e28d54', x + 0.075, 0.46, z, 0.005);
          }
        for (let i = 0; i < 3; i++)
          beam(
            [1.95 + Math.cos(i * 2.1) * 0.28, 0.2, 1.15 + Math.sin(i * 2.1) * 0.28],
            [1.95, 1.0, 1.15],
            0.025,
            '#dbad59',
          );
        box(0.28, 0.13, 0.19, '#376d65', 1.95, 1.04, 1.15, 0.025);
        const survey = person(-1.8, 1.15, -0.6);
        box(0.34, 0.035, 0.22, '#c3ddf1', 0, 0.48, 0.18, 0.01, survey);
        person(0.7, -1.8, 1.5);
      }
      if (p >= 20) {
        box(3.12, 0.23, 2.57, '#aaafa3', -0.1, 0.31, -0.3, 0.045);
        box(2.83, 0.07, 2.27, '#d5cdb8', -0.1, 0.47, -0.3, 0.02);
        box(1.1, 0.14, 0.42, '#aeb4a8', 0.2, 0.26, 1.18, 0.03);
      }
      if (p >= 40) {
        for (const x of [-1.48, -0.1, 1.28])
          for (const z of [-1.36, 0.77]) box(0.12, 1.64, 0.12, '#c49863', x, 1.31, z, 0.015);
        for (const z of [-1.36, 0.77]) box(2.9, 0.13, 0.14, '#d1ac77', -0.1, 2.05, z, 0.015);
        for (const x of [-1.48, 1.28]) box(0.14, 0.13, 2.27, '#c69d6c', x, 2.05, -0.3, 0.015);
        for (const z of [-1.35, -0.3, 0.78]) {
          beam([-1.48, 2.07, z], [-0.1, 2.98, z], 0.055, '#d0a66f');
          beam([-0.1, 2.98, z], [1.28, 2.07, z], 0.055, '#c49765');
        }
      }
      if (p >= 52) {
        const h = 1.58 * Math.min(1, (p - 50) / 20),
          cy = 0.5 + h / 2;
        box(2.78, h, 0.11, '#f0e6d5', -0.1, cy, 0.85, 0.015);
        box(2.78, h, 0.11, '#ded7c9', -0.1, cy, -1.42, 0.015);
        box(0.12, h, 2.25, '#e4dfd1', 1.34, cy, -0.3, 0.02);
        box(0.12, h, 2.25, '#eee6d4', -1.54, cy, -0.3, 0.02);
      }
      if (p >= 70) {
        roof();
        box(0.55, 1.05, 0.08, '#315d4b', 0.12, 1.03, 0.94, 0.035);
        sphere(0.035, '#d3b25a', 0.3, 1.04, 1.0);
        for (const x of [-0.87, 0.94]) {
          box(0.5, 0.64, 0.08, '#548383', x, 1.38, 0.94, 0.015);
          for (const xx of [x - 0.27, x + 0.27])
            box(0.055, 0.72, 0.05, '#fcf4df', xx, 1.38, 1.0, 0.008);
          box(0.55, 0.055, 0.055, '#fcf4df', x, 1.38, 1.0, 0.008);
          for (const yy of [1.03, 1.73]) box(0.58, 0.055, 0.055, '#fcf4df', x, yy, 1.0, 0.008);
        }
        box(0.08, 0.64, 0.7, '#628789', 1.43, 1.42, -0.4, 0.015);
        box(0.055, 0.67, 0.055, '#faf0de', 1.48, 1.42, -0.4, 0.008);
        box(0.055, 0.055, 0.75, '#faf0de', 1.48, 1.42, -0.4, 0.008);
      }
      if (p >= 85) {
        plankPath();
        tree(-2.12, -1.2, 0.87);
        tree(2.15, -1.5, 0.68);
        for (let i = 0; i < 4; i++)
          sphere(0.23, '#698d56', 1.3 + i * 0.3, 0.4, 1.42, model, 1, 0.8, 1);
        for (let i = 0; i < 6; i++) {
          box(0.09, 0.5, 0.07, '#eae6d5', -2.4, 0.48, -0.4 + i * 0.4, 0.015);
        }
        box(0.07, 0.06, 2.2, '#eee9d7', -2.4, 0.62, 0.6, 0.01);
        box(0.07, 0.06, 2.2, '#eee9d7', -2.4, 0.38, 0.6, 0.01);
      }
      if (p >= 20 && p < 85) {
        for (let i = 0; i < 4; i++)
          box(0.42, 0.11, 0.23, '#bc8660', 1.9, 0.26 + i * 0.11, 0.9, 0.01);
        for (const x of [-2, -1.7]) {
          box(0.06, 1.65, 0.06, '#bdc5b3', x, 1.04, -0.4, 0.01);
        }
        box(0.5, 0.07, 1.8, '#bc9362', -1.85, 1.22, -0.3, 0.01);
        person(-2, 1.4, 0.5);
        if (p >= 40) {
          const worker = person(1.85, -1.25, 1.6);
          worker.position.y = 0.16;
          beam([2.4, 0.2, -1.7], [2.4, 3.5, -1.7], 0.06, '#d5b65f');
          beam([0.5, 3.48, -1.7], [2.8, 3.48, -1.7], 0.06, '#e5c773');
          beam([0.8, 3.48, -1.7], [0.8, 2.65, -1.7], 0.015, '#677565');
        }
      }
    }
    function carScene(p) {
      platform('#ddd5c8');
      box(4.9, 0.035, 2.35, '#a5b3b3', 0.2, 0.22, 0.15, 0.035);
      for (const x of [-1.6, 1.7]) box(0.05, 0.02, 1.9, '#eef0da', x, 0.25, 0.15, 0.005);
      const car = new T.Group();
      car.userData.kind = 'car';
      car.position.x = p === 100 ? 0.55 : 0.2;
      model.add(car);
      box(3.05, 0.55, 1.35, '#5d8b7d', 0, 0.78, 0, 0.16, car);
      box(1.65, 0.65, 1.17, '#91b4a2', -0.18, 1.28, 0, 0.15, car);
      box(0.045, 0.45, 1.0, '#bdd5d9', 0.67, 1.3, 0, 0.015, car);
      box(1.32, 0.39, 0.035, '#b7d1d4', -0.2, 1.31, 0.61, 0.025, car);
      box(1.32, 0.39, 0.035, '#b0cbd0', -0.2, 1.31, -0.61, 0.025, car);
      box(0.055, 0.48, 0.045, '#436c5a', -0.2, 1.31, 0.635, 0.005, car);
      box(0.16, 0.13, 1.0, '#eee1b0', 1.48, 0.77, 0, 0.04, car);
      box(0.15, 0.1, 1.12, '#dce1d5', 1.55, 0.55, 0, 0.02, car);
      for (const x of [-0.95, 0.95])
        for (const z of [-0.66, 0.66]) {
          const w = cyl(0.32, 0.17, '#33413c', x, 0.48, z, car);
          w.rotation.x = Math.PI / 2;
          const hub = cyl(0.16, 0.185, '#c5cabc', x, 0.48, z, car);
          hub.rotation.x = Math.PI / 2;
        }
      box(0.75, 1.45, 0.65, '#e9e7d9', -2.05, 0.96, -1.2, 0.1);
      box(0.84, 0.28, 0.73, '#c97151', -2.05, 1.68, -1.2, 0.08);
      box(0.49, 0.42, 0.045, '#304a42', -2.05, 1.25, -0.85, 0.025);
      box(0.36, 0.1, 0.05, '#c7e69b', -2.05, 1.3, -0.82, 0.01);
      box(0.42, 0.04, 0.06, '#53675c', -2.05, 1.09, -0.82, 0.005);
      const curve =
        p >= 20
          ? new T.CatmullRomCurve3([
              new T.Vector3(-1.66, 1.3, -1.14),
              new T.Vector3(-1.2, 0.7, -1.8),
              new T.Vector3(-0.55, 0.34, -1.6),
              new T.Vector3(-0.2, 0.85, -0.65),
            ])
          : new T.CatmullRomCurve3([
              new T.Vector3(-1.66, 1.3, -1.14),
              new T.Vector3(-1.4, 0.5, -1.3),
              new T.Vector3(-1.65, 0.5, -0.8),
              new T.Vector3(-1.68, 1.1, -0.82),
            ]);
      add(new T.TubeGeometry(curve, 40, 0.045, 8, false), '#35453d', 0, 0, 0);
      for (let i = 0; i < 5; i++)
        box(
          0.28,
          0.14,
          0.05,
          i < p / 20 ? '#c9e58a' : '#647268',
          -2.05,
          0.88 - i * 0.15,
          -0.85,
          0.015,
        );
      tree(2.4, -1.65, 0.7);
      person(1.8, 1.35, -0.4, false);
    }
    function tripScene(p) {
      platform('#ebd9bc');
      box(2.5, 0.43, 1.85, '#d28a68', 0, 0.49, 0, 0.14);
      box(2.22, 0.08, 1.57, '#f0ce9e', 0, 0.73, 0, 0.07);
      if (p < 75) {
        for (let i = 0; i < Math.min(4, Math.ceil(p / 18)); i++) {
          box(
            0.82,
            0.11,
            0.61,
            ['#91af96', '#f4e3c6', '#567f7d', '#e7ba84'][i],
            i % 2 ? -0.55 : 0.53,
            0.83 + Math.floor(i / 2) * 0.13,
            i < 2 ? 0.3 : -0.36,
            0.05,
          );
          box(
            0.64,
            0.015,
            0.025,
            '#fff3d6',
            i % 2 ? -0.55 : 0.53,
            0.9 + Math.floor(i / 2) * 0.13,
            i < 2 ? 0.3 : -0.36,
            0.005,
          );
        }
      }
      const lid = new T.Group();
      lid.userData.kind = 'suitcase-lid';
      lid.position.set(0, 0.72, -0.89);
      lid.rotation.x = p < 70 ? -1.3 : p < 100 ? (-1.3 * (100 - p)) / 30 : 0;
      model.add(lid);
      box(2.5, 0.2, 1.86, '#c97552', 0, 0, 0.89, 0.1, lid);
      box(2.21, 0.04, 1.52, '#ecc79c', 0, -0.13, 0.89, 0.06, lid);
      for (const x of [-0.67, 0.67]) box(0.08, 0.025, 1.45, '#ad795a', x, -0.16, 0.89, 0.008, lid);
      for (const x of [-0.92, 0.92]) {
        const w = cyl(0.13, 0.13, '#34463d', x, 0.3, 0.82);
        w.rotation.x = Math.PI / 2;
      }
      box(0.65, 0.09, 0.12, '#765844', 0, 0.73, 1.04, 0.04);
      box(0.1, 0.15, 0.11, '#765844', -0.29, 0.67, 1.04, 0.02);
      box(0.1, 0.15, 0.11, '#765844', 0.29, 0.67, 1.04, 0.02);
      if (p < 85) {
        box(0.52, 0.07, 0.73, '#315b60', -1.94, 0.26, 0.55, 0.04);
        cyl(0.1, 0.012, '#dab76b', -1.94, 0.305, 0.5);
        box(0.72, 0.08, 0.3, '#f6f0d8', 1.8, 0.25, -0.8, 0.025);
        box(0.09, 0.085, 0.3, '#d78c57', 1.58, 0.25, -0.8, 0.005);
        box(0.55, 0.35, 0.33, '#496e68', 1.75, 0.4, 0.7, 0.06);
        const lens = cyl(0.14, 0.13, '#263f3a', 1.75, 0.42, 0.92);
        lens.rotation.x = Math.PI / 2;
      }
      if (p >= 100) {
        const handle = new T.Mesh(
          new T.TorusGeometry(0.25, 0.045, 10, 24, Math.PI),
          mat('#635444'),
        );
        handle.position.set(0, 1.18, -0.88);
        model.add(handle);
        box(0.055, 0.55, 0.055, '#737f72', -0.25, 0.93, -0.88, 0.008);
        box(0.055, 0.55, 0.055, '#737f72', 0.25, 0.93, -0.88, 0.008);
        person(-1.8, 1.05, 1.2, false);
      }
      for (let i = 0; i < 3; i++)
        box(0.75, 0.04, 0.05, '#eff1df', 1.6, 0.24, -1.4 + i * 0.17, 0.006);
    }
    function savingsScene(p) {
      cyl(2.35, 0.13, '#d2bab0', 0, 0.02, 0, model);
      cyl(2.32, 0.065, '#eadbd4', 0, 0.115, 0, model);
      const cx = -0.25,
        glass = new T.MeshPhysicalMaterial({
          color: '#edb4aa',
          roughness: 0.13,
          metalness: 0.03,
          clearcoat: 1,
          clearcoatRoughness: 0.08,
          transparent: true,
          opacity: 0.34,
          side: T.DoubleSide,
          depthWrite: false,
          reflectivity: 0.8,
        });
      const profile = [
        [0, 0.24],
        [0.61, 0.24],
        [0.82, 0.34],
        [0.95, 0.68],
        [0.99, 1.13],
        [0.94, 1.61],
        [0.74, 1.94],
        [0.73, 2.08],
        [0.65, 2.08],
        [0.65, 1.95],
        [0.86, 1.59],
        [0.91, 1.1],
        [0.86, 0.68],
        [0.74, 0.43],
        [0.55, 0.34],
        [0, 0.34],
      ].map((v) => new T.Vector2(...v));
      const jar = add(new T.LatheGeometry(profile, 72), '#edb4aa', cx, 0, 0);
      jar.material.dispose();
      jar.material = glass;
      jar.renderOrder = 4;
      jar.castShadow = false;
      jar.userData.semantic = 'peach-glass-jar';
      const rim = add(new T.TorusGeometry(0.697, 0.052, 12, 64), '#f1b9a7', cx, 2.075, 0);
      rim.rotation.x = Math.PI / 2;
      rim.material.transparent = true;
      rim.material.opacity = 0.72;
      rim.material.roughness = 0.15;
      rim.renderOrder = 5;
      for (const x of [-0.62, 0.62]) {
        const ear = add(new T.ConeGeometry(0.23, 0.42, 3), '#e9aa9f', cx + x, 1.99, 0.05);
        ear.rotation.z = x < 0 ? -0.32 : 0.32;
        ear.rotation.x = -0.15;
        ear.material.roughness = 0.38;
        const inner = add(new T.ConeGeometry(0.115, 0.23, 3), '#d68e86', cx + x, 2.05, 0.16);
        inner.rotation.copy(ear.rotation);
      }
      for (const x of [-0.58, 0.58])
        for (const z of [-0.4, 0.4]) box(0.29, 0.22, 0.37, '#dca393', cx + x, 0.25, z, 0.08);
      const snout = cyl(0.275, 0.14, '#efb6a7', cx, 1.06, 0.966);
      snout.rotation.x = Math.PI / 2;
      snout.material.roughness = 0.32;
      snout.renderOrder = 6;
      for (const x of [-0.095, 0.095]) {
        const nostril = cyl(0.035, 0.018, '#a56d67', cx + x, 1.065, 1.049);
        nostril.rotation.x = Math.PI / 2;
        nostril.renderOrder = 7;
      }
      for (const x of [-0.34, 0.34]) {
        const eye = sphere(0.039, '#573e37', cx + x, 1.46, 0.883);
        eye.renderOrder = 7;
        sphere(0.011, '#fff8ed', cx + x - 0.009, 1.475, 0.914);
      }
      const reflection = add(
        new T.TubeGeometry(
          new T.CatmullRomCurve3([
            new T.Vector3(cx - 0.79, 0.62, 0.48),
            new T.Vector3(cx - 0.87, 1.02, 0.49),
            new T.Vector3(cx - 0.79, 1.49, 0.43),
            new T.Vector3(cx - 0.64, 1.78, 0.35),
          ]),
          24,
          0.025,
          6,
          false,
        ),
        '#fff9f2',
        0,
        0,
        0,
      );
      reflection.material.transparent = true;
      reflection.material.opacity = 0.58;
      reflection.castShadow = false;
      reflection.renderOrder = 8;
      const highlight = add(
        new T.TubeGeometry(
          new T.CatmullRomCurve3([
            new T.Vector3(cx + 0.77, 1.16, 0.49),
            new T.Vector3(cx + 0.73, 1.44, 0.44),
            new T.Vector3(cx + 0.61, 1.71, 0.36),
          ]),
          18,
          0.012,
          6,
          false,
        ),
        '#fffaf3',
        0,
        0,
        0,
      );
      highlight.material.transparent = true;
      highlight.material.opacity = 0.5;
      highlight.castShadow = false;
      highlight.renderOrder = 8;
      const count = Math.floor((p / 100) * 35);
      for (let i = 0; i < count; i++) {
        const column = i % 5,
          level = Math.floor(i / 5),
          a = (column * Math.PI * 2) / 5 + 0.4,
          x = cx + Math.cos(a) * 0.43,
          z = Math.sin(a) * 0.43,
          y = 0.43 + level * 0.15;
        const coin = cyl(0.205, 0.075, i % 3 === 0 ? '#d7aa51' : '#e7c76f', x, y, z);
        coin.material.metalness = 0.48;
        coin.material.roughness = 0.32;
        coin.rotation.z = (column - 2) * 0.045;
      }
      for (let i = 0; i < 3; i++) {
        const coin = cyl(
          0.22,
          0.065,
          '#dcb55e',
          1.25 + i * 0.31,
          0.21 + i * 0.025,
          1.03 - i * 0.19,
        );
        coin.material.metalness = 0.42;
        coin.material.roughness = 0.3;
      }
    }
    function createHand() {
      handRig = new T.Group();
      handRig.userData.kind = 'coin-hand';
      stageRoot.add(handRig);
      handRig.visible = false;
      const skin = '#d59a77',
        skinLight = '#e4ad86';
      const forearm = cyl(0.19, 1.08, skin, 1.25, 0.07, 0.12, handRig, 0.17);
      forearm.rotation.z = Math.PI / 2 + 0.08;
      sphere(0.18, skin, 0.78, 0.04, 0.12, handRig, 1, 0.9, 1);
      const cuff = cyl(0.245, 0.35, '#376553', 1.84, 0.11, 0.12, handRig);
      cuff.rotation.z = Math.PI / 2;
      sphere(0.36, skinLight, 0.56, 0.015, 0.12, handRig, 1.2, 0.5, 0.92);
      sphere(0.23, skin, 0.75, -0.025, 0.14, handRig, 0.85, 0.7, 1);
      const finger1 = beam([0.44, 0.03, -0.04], [0.13, 0.0, -0.025], 0.073, skinLight, handRig);
      sphere(0.073, skinLight, 0.13, 0, -0.025, handRig);
      beam([0.13, 0, -0.025], [-0.015, -0.18, 0.025], 0.07, skinLight, handRig);
      sphere(0.072, skinLight, -0.015, -0.18, 0.025, handRig);
      beam([0.47, -0.1, 0.3], [0.18, -0.2, 0.33], 0.095, skin, handRig);
      sphere(0.095, skin, 0.18, -0.2, 0.33, handRig);
      beam([0.18, -0.2, 0.33], [0.055, -0.25, 0.21], 0.085, skinLight, handRig);
      sphere(0.087, skinLight, 0.055, -0.25, 0.21, handRig);
      for (let i = 0; i < 3; i++) {
        const z = 0.11 + i * 0.105;
        beam([0.64, -0.07, z], [0.34, -0.16, z], 0.068, skinLight, handRig);
        sphere(0.071, skinLight, 0.34, -0.16, z, handRig);
        beam([0.34, -0.16, z], [0.47, -0.23, z - 0.025], 0.063, skin, handRig);
        sphere(0.065, skin, 0.47, -0.23, z - 0.025, handRig);
      }
      sphere(0.045, '#f1cab0', -0.006, -0.174, 0.056, handRig, 0.78, 0.25, 1);
      sphere(0.052, '#f1cab0', 0.05, -0.24, 0.25, handRig, 0.8, 0.6, 0.22);
      fallingCoin = cyl(0.215, 0.055, '#e6bc60', 0, 0, 0, stageRoot);
      fallingCoin.rotation.x = Math.PI / 2;
      fallingCoin.material.metalness = 0.6;
      fallingCoin.material.roughness = 0.26;
      fallingCoin.visible = false;
      const ring = new T.Mesh(
        new T.TorusGeometry(0.174, 0.012, 8, 32),
        mat('#f5db92', { metalness: 0.55, roughness: 0.25 }),
      );
      ring.position.y = 0.032;
      ring.rotation.x = Math.PI / 2;
      fallingCoin.add(ring);
    }
    function startDeposit(callback = null) {
      if (type !== 'savings') return false;
      if (entranceStart !== null) {
        pendingDepositAt = performance.now();
        pendingDepositCallback = callback;
        wake();
        return true;
      }
      if (!motionAllowed()) {
        callback?.();
        return false;
      }
      if (depositStarted !== null) return false;
      depositStarted = performance.now();
      depositClock = 0;
      depositLanded = false;
      depositCallback = callback;
      handRig.visible = true;
      fallingCoin.visible = true;
      host.dataset.depositActive = 'true';
      host.dataset.coinPhase = 'arriving';
      wake();
      return true;
    }
    function updateDeposit(now, dt) {
      if (depositStarted === null) return false;
      const t = (depositClock += dt);
      if (t < 0.86) {
        const a = Math.min(1, t / 0.86),
          e = 1 - Math.pow(1 - a, 3);
        handRig.position.set(2.1 + (-0.25 - 2.1) * e, 4.85 + (2.98 - 4.85) * e, 0.12);
        handRig.rotation.z = 0.07 * (1 - e);
        fallingCoin.position.set(handRig.position.x, handRig.position.y - 0.27, 0.2);
        fallingCoin.rotation.set(Math.PI / 2, 0, 0.18 * (1 - e));
      } else if (t < 1.15) {
        handRig.position.set(-0.25, 2.98, 0.12);
        fallingCoin.position.set(-0.25, 2.71, 0.2);
        host.dataset.coinPhase = 'release';
      } else {
        const a = Math.min(1, (t - 1.15) / 0.68),
          landing = 0.53 + Math.floor((current / 100) * 7) * 0.15,
          dropY = 2.71 + (landing - 2.71) * a * a;
        fallingCoin.position.set(-0.25, dropY, 0.12 * (1 - a));
        fallingCoin.rotation.set(
          Math.PI / 2 - (a * Math.PI) / 2,
          0.22 * Math.sin(a * Math.PI),
          a * Math.PI * 1.3,
        );
        host.dataset.coinPhase = a < 1 ? 'falling' : 'landed';
        const retreat = Math.min(1, (t - 1.15) / 0.95),
          e = retreat * retreat;
        handRig.position.set(-0.25 + 2.45 * e, 2.98 + 2.2 * e, 0.12);
        handRig.rotation.z = 0.07 * e;
        if (a === 1 && !depositLanded) {
          depositLanded = true;
          depositCallback?.();
          depositCallback = null;
          host.dataset.coinLandings = String(Number(host.dataset.coinLandings || 0) + 1);
        }
        if (a === 1) {
          const b = Math.max(0, (t - 1.83) / 0.35);
          fallingCoin.position.y = landing + Math.sin(Math.min(1, b) * Math.PI) * 0.055;
          fallingCoin.material.opacity = Math.max(0, 1 - b);
          fallingCoin.material.transparent = true;
        }
      }
      if (t > 2.24) {
        handRig.visible = false;
        fallingCoin.visible = false;
        fallingCoin.material.opacity = 1;
        depositStarted = null;
        host.dataset.depositActive = 'false';
        host.dataset.coinPhase = 'rest';
        return false;
      }
      return true;
    }

    const liveMeshes = new Map();
    let frameId = 0,
      disposed = false,
      lastTime = performance.now(),
      firstBuild = true,
      workerUntil = 0,
      entranceStart = null,
      entranceRequested = firstOpen && motionAllowed(),
      entranceClock = 0,
      pendingDepositAt = Infinity,
      pendingDepositCallback = null;
    let handRig = null,
      fallingCoin = null,
      depositStarted = null,
      depositLanded = false,
      depositCallback = null,
      depositClock = 0;
    const tempP = new T.Vector3(),
      tempQ = new T.Quaternion(),
      tempS = new T.Vector3();
    function disposeMesh(mesh) {
      mesh.geometry.dispose();
      if (Array.isArray(mesh.material)) mesh.material.forEach((m) => m.dispose());
      else mesh.material.dispose();
    }
    function build(p) {
      model = new T.Group();
      workers = [];
      meshKeys.clear();
      (
        ({ house: homeScene, car: carScene, trip: tripScene, savings: savingsScene })[type] ||
        homeScene
      )(p);
      model.updateMatrixWorld(true);
      const present = new Set(),
        now = performance.now();
      let newCount = 0;
      model.traverse((source) => {
        if (!source.isMesh) return;
        const key =
          source.userData.stableKey ||
          'manual:' + source.geometry.type + ':' + source.position.x + ':' + source.position.z;
        present.add(key);
        source.getWorldPosition(tempP);
        source.getWorldQuaternion(tempQ);
        source.getWorldScale(tempS);
        let r = liveMeshes.get(key);
        if (!r) {
          const mesh = source.clone(false);
          mesh.frustumCulled = false;
          world.add(mesh);
          r = {
            mesh,
            source,
            targetP: tempP.clone(),
            targetQ: tempQ.clone(),
            targetS: tempS.clone(),
            targetOpacity: source.material.opacity,
            baseTransparent: source.material.transparent,
            baseDepth: source.material.depthWrite,
            removed: false,
            delay: now + (firstBuild ? 0 : Math.min(240, newCount++ * 16)),
            vertices: null,
          };
          mesh.position.copy(tempP);
          mesh.quaternion.copy(tempQ);
          mesh.scale.copy(tempS);
          if (!firstBuild && motionAllowed()) {
            mesh.position.y += 0.34;
            mesh.scale.multiplyScalar(0.92);
            mesh.material.opacity = 0;
            mesh.material.transparent = true;
            mesh.material.depthWrite = false;
          }
          liveMeshes.set(key, r);
        } else {
          const old = r.mesh.geometry,
            newGeo = source.geometry,
            oa = old.attributes.position,
            na = newGeo.attributes.position;
          if (old.type === newGeo.type && oa.count === na.count) {
            let changed = false;
            for (let i = 0; i < na.array.length; i++) {
              if (Math.abs(oa.array[i] - na.array[i]) > 0.0005) {
                changed = true;
                break;
              }
            }
            if (changed) r.vertices = new Float32Array(na.array);
            newGeo.dispose();
          } else {
            old.computeBoundingBox();
            newGeo.computeBoundingBox();
            const before = old.boundingBox.getSize(new T.Vector3()),
              after = newGeo.boundingBox.getSize(new T.Vector3());
            r.mesh.geometry = newGeo;
            r.mesh.scale.multiply(
              new T.Vector3(
                before.x / (after.x || 1),
                before.y / (after.y || 1),
                before.z / (after.z || 1),
              ),
            );
            old.dispose();
            r.vertices = null;
          }
          if (source.material !== r.mesh.material) source.material.dispose();
          r.source = source;
          r.targetP.copy(tempP);
          r.targetQ.copy(tempQ);
          r.targetS.copy(tempS);
          r.removed = false;
          r.delay = now;
        }
      });
      liveMeshes.forEach((r, key) => {
        if (!present.has(key) && !r.removed) {
          r.removed = true;
          r.targetP.y += 0.24;
          r.targetS.multiplyScalar(0.92);
          r.mesh.material.transparent = true;
          r.mesh.material.depthWrite = false;
        }
      });
      current = p;
      firstBuild = false;
      host.dataset.meshCount = String(liveMeshes.size);
      host.dataset.transitionMode = 'persistent-meshes';
      if (!motionAllowed()) settle();
      else wake();
      draw();
    }
    function settle() {
      liveMeshes.forEach((r, key) => {
        if (r.removed) {
          world.remove(r.mesh);
          disposeMesh(r.mesh);
          liveMeshes.delete(key);
          return;
        }
        r.mesh.position.copy(r.targetP);
        r.mesh.quaternion.copy(r.targetQ);
        r.mesh.scale.copy(r.targetS);
        r.mesh.material.opacity = r.targetOpacity;
        r.mesh.material.transparent = r.baseTransparent;
        r.mesh.material.depthWrite = r.baseDepth;
        if (r.vertices) {
          r.mesh.geometry.attributes.position.array.set(r.vertices);
          r.mesh.geometry.attributes.position.needsUpdate = true;
          r.vertices = null;
        }
      });
      stageRoot.position.y = 0;
      entranceStart = null;
      host.dataset.entranceState = 'settled';
    }
    function wake() {
      if (!frameId && !disposed) {
        lastTime = performance.now();
        frameId = requestAnimationFrame(frame);
      }
    }
    function frame(now) {
      frameId = 0;
      if (disposed) return;
      const dt = Math.min(0.045, Math.max(0.008, (now - lastTime) / 1000)),
        a = 1 - Math.exp(-9 * dt);
      lastTime = now;
      let active = false;
      if (!motionAllowed()) {
        const callback = depositCallback || pendingDepositCallback;
        depositCallback = null;
        pendingDepositCallback = null;
        pendingDepositAt = Infinity;
        callback?.();
        settle();
        handRig && (handRig.visible = false);
        fallingCoin && (fallingCoin.visible = false);
        depositStarted = null;
        host.dataset.depositActive = 'false';
        host.dataset.coinPhase = 'rest';
        host.dataset.sceneMoving = 'false';
        draw();
        return;
      }
      if (entranceStart !== null) {
        const t = (entranceClock += dt);
        let y = 0;
        if (t < 0.58) y = 4.6 * (1 - Math.pow(t / 0.58, 2));
        else if (t < 0.86) y = Math.sin(((t - 0.58) / 0.28) * Math.PI) * 0.18;
        else if (t < 1.03) y = Math.sin(((t - 0.86) / 0.17) * Math.PI) * 0.032;
        else entranceStart = null;
        stageRoot.position.y = y;
        host.dataset.entranceState =
          entranceStart === null ? 'settled' : t < 0.58 ? 'dropping' : 'bouncing';
        active = true;
      }
      if (now >= pendingDepositAt && entranceStart === null) {
        pendingDepositAt = Infinity;
        const callback = pendingDepositCallback;
        pendingDepositCallback = null;
        startDeposit(callback);
      }
      if (pendingDepositAt !== Infinity) active = true;
      liveMeshes.forEach((r, key) => {
        if (now < r.delay) {
          active = true;
          return;
        }
        const m = r.mesh,
          opacity = r.removed ? 0 : r.targetOpacity;
        if (m.position.distanceToSquared(r.targetP) > 0.000002) {
          m.position.lerp(r.targetP, a);
          active = true;
        } else m.position.copy(r.targetP);
        if (1 - Math.abs(m.quaternion.dot(r.targetQ)) > 0.00002) {
          m.quaternion.slerp(r.targetQ, a);
          active = true;
        } else m.quaternion.copy(r.targetQ);
        if (m.scale.distanceToSquared(r.targetS) > 0.000002) {
          m.scale.lerp(r.targetS, a);
          active = true;
        } else m.scale.copy(r.targetS);
        if (Math.abs(m.material.opacity - opacity) > 0.002) {
          m.material.opacity += (opacity - m.material.opacity) * a;
          m.material.transparent = true;
          m.material.depthWrite = false;
          active = true;
        } else {
          m.material.opacity = opacity;
          m.material.transparent = r.baseTransparent;
          m.material.depthWrite = r.baseDepth;
        }
        if (r.vertices) {
          const ar = m.geometry.attributes.position.array;
          let max = 0;
          for (let i = 0; i < ar.length; i++) {
            const diff = r.vertices[i] - ar[i];
            ar[i] += diff * a;
            max = Math.max(max, Math.abs(diff));
          }
          m.geometry.attributes.position.needsUpdate = true;
          if (max > 0.002) active = true;
          else {
            ar.set(r.vertices);
            r.vertices = null;
          }
        }
        if (r.removed && m.material.opacity < 0.012) {
          world.remove(m);
          disposeMesh(m);
          liveMeshes.delete(key);
        }
      });
      if (updateDeposit(now, dt)) active = true;
      if (now < workerUntil) active = true;
      host.dataset.sceneMoving = String(active);
      host.dataset.meshCount = String(liveMeshes.size);
      draw();
      if (active) frameId = requestAnimationFrame(frame);
    }
    function draw() {
      if (disposed) return;
      const w = host.clientWidth,
        h = host.clientHeight;
      if (!w || !h) return;
      const aspect = w / h,
        halfHeight =
          type === 'savings' ? Math.max(2.65, 3.0 / aspect) : Math.max(3.2, 3.7 / aspect);
      camera.left = -halfHeight * aspect;
      camera.right = halfHeight * aspect;
      camera.top = halfHeight;
      camera.bottom = -halfHeight;
      const angle = sceneAngle + (type === 'savings' ? 0.38 : 0);
      camera.position.set(Math.cos(angle) * 8, 6.0, Math.sin(angle) * 8);
      camera.lookAt(0, 1.3, 0);
      camera.updateProjectionMatrix();
      const size = renderer.getSize(new T.Vector2());
      if (size.x !== w || size.y !== h) renderer.setSize(w, h, false);
      renderer.render(scene, camera);
    }
    function moveActors(t) {
      workers.forEach((w, i) => {
        const arriving = type === 'house' && current < 20 ? Math.max(0, 1 - t / 1.35) : 0;
        w.g.position.x = w.baseX + (i % 2 ? -1 : 1) * arriving * 1.8 + Math.sin(t * 1.7 + i) * 0.06;
        w.g.rotation.y = Math.sin(t * 1.2 + i) * 0.12;
        w.legs.forEach((leg, j) => (leg.rotation.x = Math.sin(t * 7 + j * Math.PI) * 0.12));
        w.arms.forEach((arm, j) => (arm.rotation.x = Math.sin(t * 7 + j * Math.PI) * 0.12));
      });
      model.updateMatrixWorld(true);
      liveMeshes.forEach((r) => {
        if (r.source.userData.actor && !r.removed) {
          r.source.getWorldPosition(r.targetP);
          r.source.getWorldQuaternion(r.targetQ);
        }
      });
      workerUntil = performance.now() + 65;
      wake();
    }
    let dragging = false,
      lastX = 0;
    const down = (e) => {
        dragging = true;
        lastX = e.clientX;
        renderer.domElement.setPointerCapture(e.pointerId);
      },
      move = (e) => {
        if (!dragging) return;
        sceneAngle += (e.clientX - lastX) * 0.008;
        lastX = e.clientX;
        draw();
      },
      up = () => {
        dragging = false;
      };
    renderer.domElement.addEventListener('pointerdown', down);
    renderer.domElement.addEventListener('pointermove', move);
    renderer.domElement.addEventListener('pointerup', up);
    renderer.domElement.addEventListener('pointercancel', up);
    const ro = new ResizeObserver(draw);
    ro.observe(host);
    host.dataset.entranceCount = firstOpen && motionAllowed() ? '1' : '0';
    host.dataset.entranceState = entranceRequested ? 'dropping' : 'settled';
    if (entranceRequested) stageRoot.position.y = 4.6;
    build(pct);
    if (entranceRequested) {
      entranceStart = performance.now();
      wake();
    }
    if (type === 'savings') {
      createHand();
      if (firstOpen && motionAllowed()) {
        pendingDepositAt = performance.now() + (entranceStart !== null ? 1090 : 120);
        wake();
      }
    }
    return {
      currentPercent() {
        return current;
      },
      update(p) {
        if (p === current) return;
        const signature = (v) =>
          type === 'house'
            ? v < 20
              ? 'plan'
              : v < 40
                ? 'foundation'
                : v < 52
                  ? 'frame'
                  : v < 70
                    ? 'walls' + v
                    : v < 85
                      ? 'roof'
                      : 'home'
            : type === 'car'
              ? v >= 100
                ? 'ready'
                : Math.floor(v / 20)
              : type === 'trip'
                ? v < 70
                  ? 'packing' + Math.min(4, Math.ceil(v / 18))
                  : 'closing' + v
                : Math.floor((v / 100) * 35);
        if (signature(p) !== signature(current)) build(p);
        else current = p;
      },
      animate(t) {
        moveActors(t);
      },
      deposit(callback) {
        return startDeposit(callback);
      },
      settleTo(p) {
        cancelAnimationFrame(frameId);
        frameId = 0;
        pendingDepositAt = Infinity;
        pendingDepositCallback = null;
        depositCallback = null;
        depositStarted = null;
        if (handRig) handRig.visible = false;
        if (fallingCoin) fallingCoin.visible = false;
        host.dataset.depositActive = 'false';
        host.dataset.coinPhase = 'rest';
        build(p);
        settle();
        workerUntil = 0;
        host.dataset.sceneMoving = 'false';
        draw();
      },
      stats() {
        return {
          meshes: liveMeshes.size,
          current,
          entrance: entranceStart !== null,
          deposit: depositStarted !== null,
        };
      },
      dispose() {
        disposed = true;
        cancelAnimationFrame(frameId);
        ro.disconnect();
        liveMeshes.forEach((r) => disposeMesh(r.mesh));
        liveMeshes.clear();
        handRig?.traverse((o) => {
          if (o.isMesh) disposeMesh(o);
        });
        if (fallingCoin) {
          fallingCoin.traverse((o) => {
            if (o.isMesh) disposeMesh(o);
          });
        }
        shadow.geometry.dispose();
        shadow.material.dispose();
        light.shadow.map?.dispose();
        renderer.dispose();
        renderer.domElement.remove();
      },
      rotate() {
        sceneAngle += Math.PI / 4;
        draw();
      },
    };
  }


  function beforeRender() {
    stopGoalPlay();
    cancelAnimationFrame(contributionFrame);
    if (state.page === 'goals' && sceneController && sceneGoalId === state.activeGoal) return;
    sceneController?.dispose();
    sceneController = null;
    sceneHost = null;
    sceneGoalId = null;
    contributionTransition = null;
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.page === 'goals' && !store.state.busy) store.invalidate();
  });
  return { goals, beforeRender, mountGoalScene, handleGoalForm, motionAllowed };
}
