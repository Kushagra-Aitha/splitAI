import { requireEnv } from './env.js';

/** Nessie v2 error (RFC 9457 problem+json), with the HTTP status. */
export class NessieError extends Error {
  constructor(status, problem, path) {
    super(`Nessie ${status} on ${path}: ${problem?.title ?? 'request failed'}${problem?.detail ? ` (${problem.detail})` : ''}`);
    this.status = status;
    this.problem = problem;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Minimal Nessie v2 client. Auth is a bearer key, never a query string; all
 * money fields are integer cents. Server-side only.
 *
 * A 429 means Nessie did not process the request, so it is retried (even a
 * POST) after Retry-After. Timeouts and 5xx are NOT retried: a create may
 * have happened, and callers must reconcile instead.
 */
export async function nessie(path, { method = 'GET', body, auth = true, timeoutMs = 15_000, retries = 3 } = {}) {
  const base = requireEnv('NESSIE_BASE_URL').replace(/\/+$/, '');
  const headers = { Accept: 'application/json' };
  if (auth) headers.Authorization = `Bearer ${requireEnv('NESSIE_API_KEY')}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  for (let attempt = 0; ; attempt++) {
    const res = await fetch(base + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { title: text.slice(0, 200) };
    }
    if (res.status === 429 && attempt < retries) {
      const wait = Math.min(10, Number(res.headers.get('retry-after')) || 2 ** attempt);
      await sleep(wait * 1000);
      continue;
    }
    if (!res.ok) throw new NessieError(res.status, data, path);
    return { data, status: res.status, rateRemaining: res.headers.get('ratelimit-remaining') };
  }
}
