// Styles — order matters: later files intentionally override earlier ones.
import './styles/fonts.css';
import './styles/base.css';
import './styles/tokens.css';
import './styles/components.css';
import './styles/pages.css';
import './features/goals/styles.css';
import './features/overview/styles.css';
import './styles/motion.css';
import './styles/layout.css';
import './styles/theme-oak.css';
import './styles/shell.css';

import { mountApp } from './app.js';
import { initThemeToggle } from './theme.js';

initThemeToggle(document.getElementById('sp-theme-toggle'));
mountApp(document.getElementById('split-common-ground'));
