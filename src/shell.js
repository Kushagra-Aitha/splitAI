// B10 · App shell: the account menu (with Log out), the signed-in person in
// the header, and the connected-bank line. Routing lives in app.js.
import { getSession, logout } from './api/session.js';
import { avatarHtml } from './lib/avatar.js';

export function createShell({ root, bankLabel = () => null }) {
  const button = root.querySelector('#sp-account-button');
  const menu = root.querySelector('#sp-account-menu');
  const items = () => [...menu.querySelectorAll('[role="menuitem"]')];

  function personalize() {
    const session = getSession();
    if (!session) return;
    const { actor, email } = session;
    const first = actor.displayName.split(' ')[0];
    root.querySelectorAll('[data-account-avatar]').forEach((host) => {
      host.innerHTML = avatarHtml(actor, { size: host.dataset.size || 'md', label: false });
    });
    root.querySelector('[data-account-first]').textContent = first;
    root.querySelector('[data-account-name]').textContent = actor.displayName;
    root.querySelector('[data-account-email]').textContent = email ?? '';
    button.setAttribute('aria-label', `Account menu for ${actor.displayName}`);
  }

  function refreshBank() {
    const label = bankLabel();
    root.querySelector('[data-account-bank]').textContent = label ? `Capital Two ${label}` : 'Capital Two';
  }

  function open() {
    refreshBank();
    menu.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    items()[0]?.focus();
  }

  function close({ restoreFocus = false } = {}) {
    if (menu.hidden) return;
    menu.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    if (restoreFocus) button.focus();
  }

  button.addEventListener('click', () => (menu.hidden ? open() : close()));

  menu.addEventListener('keydown', (event) => {
    const list = items();
    const index = list.indexOf(document.activeElement);
    const move = { ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: list.length - 1 }[event.key];
    if (move !== undefined) {
      event.preventDefault();
      list[(move + list.length) % list.length]?.focus();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close({ restoreFocus: true });
    } else if (event.key === 'Tab') {
      close();
    }
  });

  button.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' && menu.hidden) {
      event.preventDefault();
      open();
    }
  });

  // Theme stays open so the change is visible; every other item closes.
  menu.addEventListener('click', (event) => {
    const item = event.target.closest('[role="menuitem"]');
    if (!item || item.id === 'sp-theme-toggle') return;
    close();
    if (item.id === 'sp-logout') {
      item.disabled = true;
      void logout();
    }
  });

  document.addEventListener('pointerdown', (event) => {
    if (!menu.hidden && !menu.contains(event.target) && !button.contains(event.target)) close();
  });

  personalize();
  return { personalize, close };
}
