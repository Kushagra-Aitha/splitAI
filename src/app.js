import { createRecurringSplits } from './features/recurring/index.js';
import { PHB, PHN } from './icons/phosphor.js';
import { createGoals } from './features/goals/index.js';
import { createOverview } from './features/overview/index.js';
import { createTogether } from './features/together/index.js';
import { createGuard } from './features/guard/index.js';
import { createAsk } from './features/ask/index.js';
import { createNotifications } from './features/notifications/index.js';
import { avatarHtml, avatarStackHtml } from './lib/avatar.js';
import { hashFor, PAGE_TITLES, parseHash } from './lib/routes.js';
import { createShell } from './shell.js';

/**
 * Mounts the Split app into the #split-common-ground element.
 */
export function mountApp(root) {
  const view = root.querySelector('#sp-view'),
    modalRoot = root.querySelector('#sp-modal-root');
  const icon = (name) => `<i data-lucide="${name}" aria-hidden="true"></i>`;
  const money = (c) =>
    new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(c / 100);
  const esc = (s) =>
    String(s).replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    );
  // The URL decides the first page (B10): refresh keeps your place.
  const initial = {
    logged: false,
    settled: false,
    blocked: false,
    cap: null,
    filter: 'all',
    ...parseHash(window.location.hash),
  };
  const state = { ...initial };
  const demo = {
    messages: [],
    draftVisible: true,
    draft: {
      merchant: 'Antonio’s',
      cents: 4200,
      people: ['Maya', 'Sam', 'Priya'],
      category: 'Food & drink',
      source: 'chat',
    },
  };
  function shareFor(name) {
    if (!demo.draft.people.includes(name)) return 0;
    const base = Math.floor(demo.draft.cents / demo.draft.people.length);
    return base + (name === 'Maya' ? demo.draft.cents - base * demo.draft.people.length : 0);
  }
  const dollarLabel = (c) => money(c).replace(/\.00$/, '');
  let dialogReturn = null, toastTimer;
  const people = {
    Maya: { initials: 'MC', tone: 'citron' },
    Sam: { initials: 'SL', tone: '' },
    Priya: { initials: 'PS', tone: 'pink' },
    Alex: { initials: 'AR', tone: 'orange' },
  };
  // Hook for saving state (e.g. to an API). No-op in the scaffold.
  function persist() {}

  function icons() {
    root.querySelectorAll('i[data-lucide]').forEach((el) => {
      const n = el.dataset.lucide,
        b = PHB[PHN[n]];
      if (!b) return;
      const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      s.setAttribute('viewBox', '0 0 256 256');
      s.setAttribute('fill', 'currentColor');
      s.setAttribute('aria-hidden', 'true');
      s.setAttribute('class', 'lucide ph-icon ph-' + PHN[n]);
      s.innerHTML = b;
      el.replaceWith(s);
    });
  }
  function avatar(n) {
    return `<span class="avatar ${people[n].tone}" aria-label="${n}">${people[n].initials}</span>`;
  }
  function stack(names = ['Maya', 'Sam', 'Priya', 'Alex']) {
    return `<div class="avatar-stack">${names.map(avatar).join('')}</div>`;
  }
  function announce(t) {
    root.querySelector('#sp-announcement').textContent = t;
  }
  function toast(t) {
    clearTimeout(toastTimer);
    root.querySelector('#sp-toast-root').innerHTML =
      `<div class="toast">${icon('check-circle-2')}<span>${esc(t)}</span></div>`;
    icons();
    announce(t);
    toastTimer = setTimeout(() => root.querySelector('#sp-toast-root').replaceChildren(), 3500);
  }
  function go(page) {
    // B13: Ask is a page in the navigation; the floating button opens the panel.
    ask.close({ restoreFocus: false });
    const fromView = view.contains(document.activeElement);
    clearTimeout(toastTimer);
    root.querySelector('#sp-toast-root').replaceChildren();
    if (page === 'guard') guardFeature.invalidate();
    state.page = page;
    state.group = null;
    render();
    if (fromView) view.querySelector('h1')?.focus({ preventScroll: true });
    persist();
  }
  function heading(eyebrow, title, sub, action = '') {
    return `<div class="heading"><div><div class="eyebrow">${eyebrow}</div><h1 tabindex="-1">${title}</h1>${sub ? `<p>${sub}</p>` : ''}</div>${action}</div>`;
  }
  function openModal(title, html) {
    clearTimeout(toastTimer);
    root.querySelector('#sp-toast-root').replaceChildren();
    dialogReturn = document.activeElement;
    root.querySelector('.main').inert = true;
    root.querySelector('.book-header').inert = true;
    for (const element of root.querySelectorAll('.bottom-nav, .ask-fab, .ask-panel')) element.inert = true;
    modalRoot.innerHTML = `<div class="modal-layer"><section class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}">${html}</section></div>`;
    icons();
    modalRoot.querySelector('button,input,select')?.focus({ preventScroll: true });
  }
  function closeModal() {
    const panelOpen = !!root.querySelector('.ask-layer:not([hidden])');
    for (const element of root.querySelectorAll('.main, .book-header, .bottom-nav, .ask-fab')) element.inert = panelOpen;
    root.querySelector('.ask-panel')?.removeAttribute('inert');
    modalRoot.replaceChildren();
    if (dialogReturn?.isConnected) dialogReturn.focus({ preventScroll: true });
  }
  const closeButton = `<button type="button" class="icon-button cursor-interaction" data-action="close" aria-label="Close dialog">${icon('x')}</button>`;

  const context = {
    root, view, state, demo, icon, icons, money, dollarLabel, esc, heading, avatar, stack,
    personAvatar: avatarHtml, avatarStack: avatarStackHtml,
    shareFor, render, persist, announce, openModal, closeModal, closeButton, toast, go,
  };
  const goalsFeature = createGoals(context);
  // Overview reuses A5's ticket; Together is created after it (it needs tx),
  // so these resolve at call time.
  const overview = createOverview({ ...context,
    draftTicket: (...args) => together.draftTicket(...args),
    registerReview: (draft, handlers) => together.registerReview(draft, handlers) });
  const together = createTogether({ ...context, tx: overview.tx });
  const recurringSplits = createRecurringSplits({ ...context, draftTicket: together.draftTicket,
    registerReview: together.registerReview, openGroup: together.openGroup });
  const guardFeature = createGuard({ ...context, openGroup: together.openGroup });
  const ask = createAsk({ ...context, draftTicket: together.draftTicket,
    registerReview: together.registerReview, openGroupCreation: together.openGroupCreation });
  createNotifications({ ...context, icons, openGroup: together.openGroup,
    onRefresh(items) { together.onNotifications(items); guardFeature.onNotifications(items); } });
  const pages = {
    home: overview.home, transactions: overview.transactions, profile: overview.profile, groups: together.groups,
    guard: guardFeature.guard, goals: goalsFeature.goals, chat: ask.chat,
  };
  createShell({ root, bankLabel: overview.bankLabel });

  // Keep the URL in step with the page. A change made by the app (a nav click,
  // opening a group) adds a history entry; the first render only normalizes.
  let routed = false;
  function syncHash() {
    const want = hashFor(state);
    if (window.location.hash !== want) {
      window.history[routed ? 'pushState' : 'replaceState'](null, '', want);
    }
    routed = true;
  }
  window.addEventListener('hashchange', () => {
    const next = parseHash(window.location.hash);
    if (next.page === state.page && next.group === state.group) return;
    ask.close({ restoreFocus: false });
    closeModal();
    if (next.page === 'guard') guardFeature.invalidate();
    Object.assign(state, next);
    render();
    view.querySelector('h1')?.focus({ preventScroll: true });
  });

  function render() {
    goalsFeature.beforeRender();
    overview.resetCharts();
    root.querySelectorAll('[data-page]').forEach((b) => {
      if (b.dataset.page === state.page) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });
    if (!pages[state.page]) state.page = 'home';
    root.dataset.page = state.page;
    document.title = `${PAGE_TITLES[state.page]} · Split`;
    view.innerHTML = `<div class="content-enter">${pages[state.page]()}</div>`;
    syncHash();
    icons();
    overview.mountMoneyCharts();
    together.afterRender();
    recurringSplits.afterRender();
    if (state.page === 'goals') goalsFeature.mountGoalScene();
  }
  root.addEventListener(
    'invalid',
    (e) => {
      if (goalsFeature.motionAllowed())
        e.target.animate(
          [
            { transform: 'translateX(0)' },
            { transform: 'translateX(-3px)' },
            { transform: 'translateX(3px)' },
            { transform: 'translateX(0)' },
          ],
          { duration: 180, easing: 'ease-out' },
        );
    },
    true,
  );

  root.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.type === 'submit' && b.form) {
      e.preventDefault();
      if (b.form.reportValidity()) handleForm(b.form);
      return;
    }
    if (b.dataset.page) {
      go(b.dataset.page);
      return;
    }
    if (b.dataset.go) {
      closeModal();
      go(b.dataset.go);
      return;
    }
    if (b.dataset.action === 'close') closeModal();
  });

  function handleForm(form) {
    const fd = new FormData(form);
    if (goalsFeature.handleGoalForm(form, fd) || recurringSplits.handleForm(form, fd)) return;
    together.handleExpenseForm(form, fd);
    ask.handleAskForm(form, fd);
    overview.handleOverviewForm(form, fd);
  }
  root.addEventListener('submit', (e) => {
    e.preventDefault();
    if (e.target.reportValidity()) handleForm(e.target);
  });
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.matches('input')) {
      const f = e.target.closest('form');
      if (f) {
        e.preventDefault();
        if (f.reportValidity()) handleForm(f);
      }
    }
  });
  root.addEventListener('keydown', (e) => {
    if (!modalRoot.children.length) return;
    if (e.key === 'Escape') {
      closeModal();
      return;
    }
    if (e.key === 'Tab') {
      const nodes = [
          ...modalRoot.querySelectorAll('button,input,select,textarea,a[href],summary,[tabindex]'),
        ].filter((n) => !n.matches(':disabled') && !n.hidden && n.tabIndex >= 0 && n.getClientRects().length && !n.closest('[inert]')),
        first = nodes[0],
        last = nodes.at(-1);
      if (!first) { e.preventDefault(); return; }
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  });
  render();
  overview.observe();
}
