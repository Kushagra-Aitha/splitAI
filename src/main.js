// Styles — order matters: later files intentionally override earlier ones.
import './styles/fonts.css';
import './styles/base.css';
import './styles/tokens.css';
import './styles/components.css';
import './styles/pages.css';
import './features/goals/styles.css';
import './features/overview/styles.css';
import './features/ask/styles.css';
import './features/guard/styles.css';
import './features/notifications/styles.css';
import './features/together/activity.css';
import './styles/motion.css';
import './styles/layout.css';
import './styles/theme-oak.css';
import './styles/shell.css';
import './styles/ui.css';
import './styles/session.css';
import './styles/look.css';

import { mountApp } from './app.js';
import { initThemeToggle } from './theme.js';
import { initializeSession } from './api/session.js';

initThemeToggle(document.getElementById('sp-theme-toggle'));
const root = document.getElementById('split-common-ground');
initializeSession(root).then(async () => {
  if (/^\/bank\/?$/.test(window.location.pathname)) (await import('./features/bank/index.js')).mountBank(root);
  else mountApp(root);
});
