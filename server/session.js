// B8 · Email/password accounts on top of F3's session boundary: an HttpOnly
// SameSite=Strict cookie, a per-session CSRF token, and exact-Origin checks in
// app.js. Users and sessions persist in the auth store (Tiger Data in the
// server, memory in tests), so logins survive a restart.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { HttpError } from './http.js';
import { hashPassword, PASSWORD_MAX_BYTES, PASSWORD_MIN_CHARS, verifyPassword } from './auth/password.js';

export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_BUCKETS = 10_000;
const IP_WINDOW_MS = 60_000;
const IP_LIMIT = 10; // sign-in and sign-up attempts per IP per minute
const EMAIL_WINDOW_MS = 15 * 60_000;
const EMAIL_FAILURES = 5; // wrong passwords per email per 15 minutes
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CONTROL = /\p{Cc}/u;
// Sign-up waits this long for after-sign-up work (B9 bank account) before
// answering; the work keeps running and is repeat-safe if it finishes later.
export const SIGNUP_HOOK_WAIT_MS = 10_000;

const invalidCredentials = () => new HttpError(401, 'INVALID_CREDENTIALS', 'That email and password don’t match.');
const invalid = (message) => new HttpError(422, 'VALIDATION_ERROR', message);
const rateLimited = () => new HttpError(429, 'LOGIN_RATE_LIMITED', 'Too many sign-in attempts. Try again in a few minutes.');

function equalSecret(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const digest = (value) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(left), digest(right));
}

const sha256 = (token) => createHash('sha256').update(token).digest();

export function normalizeEmail(value) {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  return email.length <= 254 && EMAIL.test(email) ? email : null;
}

function readName(value) {
  const name = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  if (!name || name.length > 80 || CONTROL.test(name)) throw invalid('Enter your name (up to 80 characters).');
  return name;
}

function readNewPassword(value) {
  if (typeof value !== 'string' || [...value].length < PASSWORD_MIN_CHARS) {
    throw invalid(`Use a password with at least ${PASSWORD_MIN_CHARS} characters.`);
  }
  if (Buffer.byteLength(value) > PASSWORD_MAX_BYTES) throw invalid('That password is too long.');
  return value;
}

export function initialsFor(name) {
  const parts = name.split(' ').filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts.at(-1)[0] : '')).toUpperCase() || '?';
}

export function createSessions(config, { store, now = Date.now, onSignup }) {
  if (!store) throw new Error('createSessions needs an auth store.');
  const ipBuckets = new Map();
  const emailBuckets = new Map();
  const cookieName = config.secureCookies ? '__Host-split-session' : 'split-session';
  const cookie = (value, ageMs) => `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(ageMs / 1000)}${config.secureCookies ? '; Secure' : ''}`;
  let lastSweep = 0;

  function tokenFrom(req) {
    const cookies = (req.headers.cookie || '').split(';').map((part) => part.trim().split('='));
    const values = cookies.filter(([name]) => name === cookieName);
    return values.length === 1 && /^[a-f0-9]{64}$/.test(values[0][1]) ? values[0][1] : null;
  }

  function prune(map) {
    const time = now();
    for (const [k, bucket] of map) if (bucket.until <= time) map.delete(k);
  }

  // Trust the socket, never a client-supplied forwarding header. Behind a
  // proxy this deliberately shares the limit; edge rate limits belong to B7.
  function limitIp(req, res) {
    prune(ipBuckets);
    const ip = req.socket.remoteAddress;
    let bucket = ipBuckets.get(ip);
    if (!bucket) {
      if (ipBuckets.size >= MAX_BUCKETS) throw rateLimited();
      bucket = { count: 0, until: now() + IP_WINDOW_MS };
      ipBuckets.set(ip, bucket);
    }
    if (++bucket.count > IP_LIMIT) {
      res.setHeader('Retry-After', Math.max(1, Math.ceil((bucket.until - now()) / 1000)));
      throw rateLimited();
    }
  }

  function emailLocked(email, res) {
    prune(emailBuckets);
    const bucket = emailBuckets.get(email);
    if (bucket && bucket.count >= EMAIL_FAILURES) {
      res.setHeader('Retry-After', Math.max(1, Math.ceil((bucket.until - now()) / 1000)));
      return true;
    }
    return false;
  }

  function recordFailure(email) {
    if (!email) return;
    let bucket = emailBuckets.get(email);
    if (!bucket) {
      if (emailBuckets.size >= MAX_BUCKETS) return;
      bucket = { count: 0, until: now() + EMAIL_WINDOW_MS };
      emailBuckets.set(email, bucket);
    }
    bucket.count++;
  }

  async function issue(req, res, actor, email) {
    const oldToken = tokenFrom(req);
    if (oldToken) await store.deleteSession(sha256(oldToken));
    const time = now();
    if (time - lastSweep > 60 * 60_000) {
      lastSweep = time;
      await store.deleteExpired(time);
    }
    const token = randomBytes(32).toString('hex');
    const session = Object.freeze({
      actor: Object.freeze({ userId: actor.userId, displayName: actor.displayName }),
      email,
      csrfToken: randomBytes(32).toString('hex'),
      expiresAt: time + SESSION_TTL_MS,
    });
    await store.createSession({ tokenHash: sha256(token), userId: actor.userId, csrfToken: session.csrfToken, expiresAt: session.expiresAt });
    res.setHeader('Set-Cookie', cookie(token, SESSION_TTL_MS));
    return session;
  }

  return {
    // Only name, email and password are read; identity fields in the body are
    // ignored, so signing up or in can never select another user or account.
    async signup(req, res, body) {
      limitIp(req, res);
      const name = readName(body.name);
      const email = normalizeEmail(body.email);
      if (!email) throw invalid('Enter a valid email address.');
      const password = readNewPassword(body.password);
      const [first] = name.split(' ');
      const user = await store.createUser({
        email, displayName: first, fullName: name, initials: initialsFor(name), passwordHash: await hashPassword(password),
      });
      if (!user) throw new HttpError(409, 'EMAIL_TAKEN', 'An account with that email already exists. Log in instead.');
      const session = await issue(req, res, user, email);
      if (onSignup) {
        // A failure here never fails sign-up; the app offers a retry instead.
        let timer;
        const work = Promise.resolve().then(() => onSignup(session.actor)).catch(() => {});
        await Promise.race([work, new Promise((resolve) => { timer = setTimeout(resolve, SIGNUP_HOOK_WAIT_MS); })]);
        clearTimeout(timer);
      }
      return session;
    },

    async login(req, res, body) {
      limitIp(req, res);
      const email = normalizeEmail(body.email);
      const password = typeof body.password === 'string' && Buffer.byteLength(body.password) <= PASSWORD_MAX_BYTES ? body.password : '';
      if (email && emailLocked(email, res)) throw rateLimited();
      const user = email ? await store.findUserByEmail(email) : null;
      // Always run one scrypt verification so timing does not reveal accounts.
      const ok = await verifyPassword(password, user?.passwordHash ?? null);
      if (!user || !ok || !password) {
        recordFailure(email);
        throw invalidCredentials();
      }
      emailBuckets.delete(email);
      return issue(req, res, user, email);
    },

    async require(req) {
      const token = tokenFrom(req);
      const session = token ? await store.findSession(sha256(token), now()) : null;
      if (!session) throw new HttpError(401, 'SESSION_REQUIRED', 'Log in to continue.');
      return Object.freeze({ ...session, actor: Object.freeze({ ...session.actor }) });
    },

    requireCsrf(req, session) {
      if (!equalSecret(req.headers['x-csrf-token'], session.csrfToken)) {
        throw new HttpError(403, 'CSRF_FORBIDDEN', 'Refresh the app and try again.');
      }
    },

    async logout(req, res) {
      const token = tokenFrom(req);
      if (token) await store.deleteSession(sha256(token));
      res.setHeader('Set-Cookie', cookie('', 0));
    },
  };
}
