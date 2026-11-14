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
export async function apiRequest(path, { method = 'GET', body } = {}) {
  if (!path.startsWith('/api/') || path.includes('\\')) throw new Error('Use a relative API path.');
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (!['GET', 'HEAD'].includes(method) && session) headers['X-CSRF-Token'] = session.csrfToken;
  const response = await fetch(path, {
    method, headers, credentials: 'same-origin', redirect: 'error',
    signal: AbortSignal.timeout(15_000),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (response.status === 401) session = null;
  if (response.status === 204) return null;
  const data = await response.json();
  if (!response.ok) {
    throw new ApiError(response.status, data.error?.code || 'REQUEST_FAILED', data.error?.message || 'The request failed.');
  }
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

export async function initializeSession(root) {
  root.hidden = true;
  const gate = document.createElement('section');
  gate.className = 'session-gate';
  gate.setAttribute('aria-label', 'Split AI demo sign in');
  // Static markup only. Server and user values are assigned through textContent.
  gate.innerHTML = `<div class="session-card"><p class="session-brand">split.</p><h1>Welcome to the demo.</h1><p>Use your demo access code to open the shared sandbox.</p><form><label for="demo-access-code">Demo access code</label><input id="demo-access-code" name="accessCode" type="password" autocomplete="current-password" maxlength="256" required><p class="session-error" role="alert"></p><button type="submit">Open Split</button></form><p class="session-status" role="status">Connecting…</p></div>`;
  root.before(gate);
  const form = gate.querySelector('form');
  const input = gate.querySelector('input');
  const button = gate.querySelector('button');
  const error = gate.querySelector('.session-error');
  const status = gate.querySelector('.session-status');
  form.hidden = true;
  function openApp() {
    gate.remove();
    root.hidden = false;
  }
  try {
    rememberSession(await apiRequest('/api/session'));
    openApp();
    return session;
  } catch (failure) {
    status.textContent = '';
    form.hidden = false;
    if (!(failure instanceof ApiError && failure.status === 401)) {
      error.textContent = 'Unable to connect to Split. Check your connection and try again.';
    }
  }
  input.focus();
  return new Promise((resolve) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (button.disabled) return;
      button.disabled = true;
      error.textContent = '';
      status.textContent = 'Signing in…';
      try {
        rememberSession(await apiRequest('/api/session', { method: 'POST', body: { accessCode: input.value } }));
        input.value = '';
        openApp();
        resolve(session);
      } catch (failure) {
        error.textContent = failure instanceof ApiError && failure.status === 401
          ? 'The demo access code is incorrect.'
          : failure instanceof ApiError && failure.status === 429
            ? 'Too many sign-in attempts. Try again in a minute.'
            : 'Unable to open Split. Check your connection and try again.';
        status.textContent = '';
        button.disabled = false;
        input.focus();
      }
    });
  });
}
