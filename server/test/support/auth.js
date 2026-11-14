// Test helper (B8): an in-memory auth store with known users, and a login
// through the real POST /api/auth/login route. Not a test file itself.
import { createMemoryAuthStore } from '../../auth/store.js';

export const TEST_PASSWORD = 'test-only-password-123';

export async function memoryAuth(users) {
  const authStore = createMemoryAuthStore();
  for (const user of users) await authStore.addUser({ password: TEST_PASSWORD, ...user });
  return authStore;
}

/** Logs in and returns { status, cookie, session } for the given base URL. */
export async function loginAs(base, origin, email, password = TEST_PASSWORD) {
  const response = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }),
  });
  const cookie = response.headers.get('set-cookie')?.split(';', 1)[0] ?? null;
  return { status: response.status, cookie, session: await response.json() };
}
