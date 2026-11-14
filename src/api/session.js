import { financialChanged } from './financial-state.js';

let session = null;

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function getSession() {
  return session;
}

// Later feature modules use relative URLs and the same trusted session. Never
// put provider credentials, a selected actor, or session tokens in storage.
export async function apiRequest(path, { method = 'GET', body, timeoutMs = 15_000, signal } = {}) {
  if (!path.startsWith('/api/') || path.includes('\\')) throw new Error('Use a relative API path.');
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (!['GET', 'HEAD'].includes(method) && session) headers['X-CSRF-Token'] = session.csrfToken;
  const response = await fetch(path, {
    method, headers, credentials: 'same-origin', redirect: 'error',
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (response.status === 401) session = null;
  if (response.status === 204) return null;
  const data = await response.json();
  if (!response.ok) {
    throw new ApiError(response.status, data.error?.code || 'REQUEST_FAILED', data.error?.message || 'The request failed.');
  }
  if (method === 'POST' && /^\/api\/(?:goals(?:\/|$)|expense-drafts\/[^/]+\/confirm$|settlement-reviews\/[^/]+\/confirm$)/.test(path)) financialChanged();
  return data;
}

function rememberSession(value) {
  if (!value?.actor || typeof value.actor.userId !== 'string' || typeof value.actor.displayName !== 'string' ||
      !/^[a-f0-9]{64}$/.test(value.csrfToken) || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= Date.now()) {
    throw new Error('Invalid session response.');
  }
  session = Object.freeze({ ...value, actor: Object.freeze({ ...value.actor }) });
  return session;
}

const LOGIN_MESSAGES = {
  401: 'That email and password don’t match.',
  429: 'Too many sign-in attempts. Try again in a few minutes.',
};

function failureMessage(failure) {
  if (failure instanceof ApiError) {
    if (LOGIN_MESSAGES[failure.status]) return LOGIN_MESSAGES[failure.status];
    if ([409, 422].includes(failure.status)) return failure.message;
  }
  return 'Unable to reach Split. Check your connection and try again.';
}

/** Ends this browser's session and returns to the login screen. */
export async function logout() {
  try {
    await apiRequest('/api/auth/logout', { method: 'POST', body: {} });
  } finally {
    session = null;
    window.location.reload();
  }
}

export async function initializeSession(root) {
  root.hidden = true;
  const gate = document.createElement('section');
  gate.className = 'session-gate';
  gate.setAttribute('aria-label', 'Log in to Split');
  // Static markup only. Server and user values are assigned through textContent.
  gate.innerHTML = `<div class="session-shell"><aside class="session-aside" aria-hidden="true"><p class="session-brand">split<span>.</span></p>
    <p class="session-pitch">Split shared costs straight from your bank.</p>
    <ul><li>Your Capital Two purchases sync automatically</li><li>Pick a transaction, choose a group, done</li><li>Guard flags shady payment requests</li></ul></aside>
    <div class="session-card"><p class="session-brand session-brand-inline">split<span>.</span></p>
    <form data-mode="login" aria-labelledby="sp-login-title"><h1 id="sp-login-title">Welcome back.</h1><p>Log in to see your money and your groups.</p>
      <label for="sp-login-email">Email</label><input id="sp-login-email" name="email" type="email" autocomplete="username" maxlength="254" required>
      <label for="sp-login-password">Password</label><input id="sp-login-password" name="password" type="password" autocomplete="current-password" maxlength="256" required>
      <p class="session-error" role="alert"></p><button type="submit">Log in</button>
      <p class="session-switch">New to Split? <button type="button" class="session-link" data-switch="signup">Create an account</button></p>
      <p class="session-demo">Demo account: <strong>maya@split.test</strong></p></form>
    <form data-mode="signup" aria-labelledby="sp-signup-title" hidden><h1 id="sp-signup-title">Create your account.</h1><p>Split costs with the people you live and travel with.</p>
      <label for="sp-signup-name">Your name</label><input id="sp-signup-name" name="name" autocomplete="name" maxlength="80" required>
      <label for="sp-signup-email">Email</label><input id="sp-signup-email" name="email" type="email" autocomplete="email" maxlength="254" required>
      <label for="sp-signup-password">Password</label><input id="sp-signup-password" name="password" type="password" autocomplete="new-password" minlength="8" maxlength="256" required aria-describedby="sp-password-hint">
      <p id="sp-password-hint" class="session-hint">At least 8 characters.</p>
      <p class="session-error" role="alert"></p><button type="submit">Create account</button>
      <p class="session-switch">Already have an account? <button type="button" class="session-link" data-switch="login">Log in</button></p></form>
    <p class="session-status" role="status">Connecting…</p></div></div>`;
  root.before(gate);
  const forms = [...gate.querySelectorAll('form')];
  const status = gate.querySelector('.session-status');
  forms.forEach((form) => { form.hidden = true; });
  function openApp() {
    gate.remove();
    root.hidden = false;
  }
  function show(mode) {
    for (const form of forms) {
      form.hidden = form.dataset.mode !== mode;
      form.querySelector('.session-error').textContent = '';
    }
    gate.querySelector(`form[data-mode="${mode}"] input`).focus();
  }
  try {
    rememberSession(await apiRequest('/api/session'));
    openApp();
    return session;
  } catch (failure) {
    status.textContent = '';
    show('login');
    if (!(failure instanceof ApiError && failure.status === 401)) {
      forms[0].querySelector('.session-error').textContent = 'Unable to connect to Split. Check your connection and try again.';
    }
  }
  gate.addEventListener('click', (event) => {
    const target = event.target.closest('[data-switch]');
    if (target) show(target.dataset.switch);
  });
  return new Promise((resolve) => {
    for (const form of forms) {
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const button = form.querySelector('[type="submit"]');
        const error = form.querySelector('.session-error');
        if (button.disabled) return;
        button.disabled = true;
        error.textContent = '';
        status.textContent = form.dataset.mode === 'signup' ? 'Creating your account…' : 'Logging in…';
        const fields = Object.fromEntries(new FormData(form));
        try {
          rememberSession(await apiRequest(`/api/auth/${form.dataset.mode}`, { method: 'POST', body: fields }));
          form.reset();
          openApp();
          resolve(session);
        } catch (failure) {
          error.textContent = failureMessage(failure);
          status.textContent = '';
          button.disabled = false;
          form.querySelector('input[type="password"]').value = '';
          form.querySelector(failure instanceof ApiError && failure.status === 401 ? 'input[type="password"]' : 'input').focus();
        }
      });
    }
  });
}
