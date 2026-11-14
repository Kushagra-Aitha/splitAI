const STORAGE_KEY = 'split-theme';

function save(theme) {
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    /* storage unavailable — theme still applies for this visit */
  }
}

function apply(theme, button) {
  document.documentElement.dataset.theme = theme;
  if (button) {
    const next = theme === 'dark' ? 'light' : 'dark';
    // In the account menu the visible text names the mode you switch to.
    const label = button.querySelector('[data-theme-label]');
    if (label) label.textContent = `${next === 'dark' ? 'Dark' : 'Light'} mode`;
    else {
      button.setAttribute('aria-label', `Switch to ${next} mode`);
      button.title = `Switch to ${next} mode`;
    }
  }
}

/**
 * Light/dark toggle. The initial theme is set by the inline script in
 * index.html (saved choice, else system preference) to avoid a flash.
 */
export function initThemeToggle(button) {
  apply(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light', button);
  button?.addEventListener('click', () => {
    const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    apply(theme, button);
    save(theme);
  });
}
