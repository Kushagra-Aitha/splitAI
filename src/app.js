import { PHB, PHN } from './icons/phosphor.js';
import { createGoals } from './features/goals/index.js';
import { createOverview } from './features/overview/index.js';
import { createTogether } from './features/together/index.js';
import { createGuard } from './features/guard/index.js';
import { createAsk } from './features/ask/index.js';

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
  const initial = {
    page: 'goals',
    logged: false,
    settled: false,
    blocked: false,
    cap: null,
    group: null,
    filter: 'all',
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
    clearTimeout(toastTimer);
    root.querySelector('#sp-toast-root').replaceChildren();
    if (page === 'guard') guardFeature.invalidate();
    state.page = page;
    state.group = null;
    render();
    persist();
  }
  function heading(eyebrow, title, sub, action = '') {
    return `<div class="heading"><div><div class="eyebrow">${eyebrow}</div><h1>${title}</h1>${sub ? `<p>${sub}</p>` : ''}</div>${action}</div>`;
  }
  function openModal(title, html) {
    clearTimeout(toastTimer);
    root.querySelector('#sp-toast-root').replaceChildren();
    dialogReturn = document.activeElement;
    root.querySelector('.main').inert = true;
    root.querySelector('.book-header').inert = true;
    modalRoot.innerHTML = `<div class="modal-layer"><section class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}">${html}</section></div>`;
    icons();
    setTimeout(
      () => modalRoot.querySelector('button,input,select')?.focus({ preventScroll: true }),
      30,
    );
  }
  function closeModal() {
    root.querySelector('.main').inert = false;
    root.querySelector('.book-header').inert = false;
    modalRoot.replaceChildren();
    if (dialogReturn?.isConnected) dialogReturn.focus({ preventScroll: true });
  }
  const closeButton = `<button type="button" class="icon-button cursor-interaction" data-action="close" aria-label="Close dialog">${icon('x')}</button>`;

  const context = {
    root, view, state, demo, icon, icons, money, dollarLabel, esc, heading, avatar, stack,
    shareFor, render, persist, announce, openModal, closeModal, closeButton, toast, go,
  };
  const goalsFeature = createGoals(context);
  // Overview reuses A5's ticket; Together is created after it (it needs tx),
  // so these resolve at call time.
  const overview = createOverview({ ...context,
    draftTicket: (draft) => together.draftTicket(draft),
    registerReview: (draft, handlers) => together.registerReview(draft, handlers) });
  const together = createTogether({ ...context, tx: overview.tx });
  const guardFeature = createGuard(context);
  const ask = createAsk({ ...context, draftTicket: together.draftTicket,
    registerReview: together.registerReview, openGroupCreation: together.openGroupCreation });
  const pages = {
    home: overview.home, profile: overview.profile, groups: together.groups,
    guard: guardFeature.guard, goals: goalsFeature.goals, chat: ask.chat,
  };

  function render() {
    goalsFeature.beforeRender();
    overview.resetCharts();
    root.querySelectorAll('[data-page]').forEach((b) => {
      if (b.dataset.page === state.page) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });
    root.querySelector('#sp-breadcrumb').textContent =
      {
        home: 'Overview',
        chat: 'Ask Split',
        groups: 'Your groups',
        goals: 'Goals',
        profile: 'Profile',
        guard: 'Guard log',
      }[state.page] || 'Overview';
    view.innerHTML = `<div class="content-enter">${(pages[state.page] || pages.home)()}</div>`;
    // Overview and Profile carry no footer or marketing copy (B6).
    const footer = root.querySelector('.page-footer');
    if (footer) footer.style.display = ['home', 'profile'].includes(state.page) || !pages[state.page] ? 'none' : '';
    icons();
    overview.mountMoneyCharts();
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
    if (goalsFeature.handleGoalForm(form, fd)) return;
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
          ...modalRoot.querySelectorAll('button,input,select,textarea,a[href],summary'),
        ].filter((n) => !n.disabled && !n.hidden),
        first = nodes[0],
        last = nodes.at(-1);
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
