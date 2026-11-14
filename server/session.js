import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { HttpError } from './http.js';

const TTL_MS = 8 * 60 * 60 * 1000;
const MAX_SESSIONS = 1000;
const MAX_ATTEMPT_BUCKETS = 1000;
const ATTEMPT_WINDOW_MS = 60_000;

function equalSecret(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const digest = (value) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(left), digest(right));
}

export function createSessions(config, { now = Date.now } = {}) {
  const sessions = new Map();
  const attempts = new Map();
  const cookieName = config.secureCookies ? '__Host-split-session' : 'split-session';
  const cookie = (value, age) => `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${config.secureCookies ? '; Secure' : ''}`;

  function tokenFrom(req) {
    const cookies = (req.headers.cookie || '').split(';').map((part) => part.trim().split('='));
    const values = cookies.filter(([name]) => name === cookieName);
    return values.length === 1 && /^[a-f0-9]{64}$/.test(values[0][1]) ? values[0][1] : null;
  }

  function prune() {
    const time = now();
    for (const [token, session] of sessions) if (session.expiresAt <= time) sessions.delete(token);
    for (const [ip, attempt] of attempts) if (attempt.until <= time) attempts.delete(ip);
  }

  return {
    login(req, res, accessCode) {
      prune();
      // Trust the socket, never a client-supplied forwarding header. Behind a
      // proxy this deliberately shares the limit; edge rate limits belong to B7.
      const ip = req.socket.remoteAddress;
      let bucket = attempts.get(ip);
      if (!bucket) {
        if (attempts.size >= MAX_ATTEMPT_BUCKETS) {
          throw new HttpError(429, 'LOGIN_RATE_LIMITED', 'Too many sign-in attempts. Try again in a minute.');
        }
        bucket = { count: 0, until: now() + ATTEMPT_WINDOW_MS };
        attempts.set(ip, bucket);
      }
      if (++bucket.count > 10) {
        res.setHeader('Retry-After', Math.max(1, Math.ceil((bucket.until - now()) / 1000)));
        throw new HttpError(429, 'LOGIN_RATE_LIMITED', 'Too many sign-in attempts. Try again in a minute.');
      }
      if (!equalSecret(accessCode, config.accessCode)) {
        throw new HttpError(401, 'INVALID_ACCESS_CODE', 'The demo access code is incorrect.');
      }
      const oldToken = tokenFrom(req);
      if (oldToken) sessions.delete(oldToken);
      if (sessions.size >= MAX_SESSIONS) {
        throw new HttpError(503, 'SESSION_CAPACITY', 'The demo is busy. Try again later.');
      }
      const token = randomBytes(32).toString('hex');
      const session = Object.freeze({
        actor: config.actor,
        csrfToken: randomBytes(32).toString('hex'),
        expiresAt: now() + TTL_MS,
      });
      sessions.set(token, session);
      res.setHeader('Set-Cookie', cookie(token, TTL_MS / 1000));
      return session;
    },
    require(req) {
      const token = tokenFrom(req);
      const session = sessions.get(token);
      if (!session || session.expiresAt <= now()) {
        if (token) sessions.delete(token);
        throw new HttpError(401, 'SESSION_REQUIRED', 'Sign in to the demo to continue.');
      }
      return session;
    },
    requireCsrf(req, session) {
      if (!equalSecret(req.headers['x-csrf-token'], session.csrfToken)) {
        throw new HttpError(403, 'CSRF_FORBIDDEN', 'Refresh the app and try again.');
      }
    },
    logout(req, res) {
      sessions.delete(tokenFrom(req));
      res.setHeader('Set-Cookie', cookie('', 0));
    },
  };
}
