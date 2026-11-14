import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { HttpError, readJson, requireSameOrigin, sendJson } from './http.js';
import { matchRoutes, routes } from './routes.js';
import { createSessions } from './session.js';

export function createApp({ config, handlers = {}, serveStatic, now, onError = () => {} }) {
  for (const [name, handler] of Object.entries(handlers)) {
    if (!routes.some((route) => route.name === name) || typeof handler !== 'function') {
      throw new Error('Unknown or invalid feature handler.');
    }
  }
  const sessions = createSessions(config, { now });
  const server = createServer({ maxHeaderSize: 16 * 1024, requestTimeout: 30_000, headersTimeout: 10_000 }, async (req, res) => {
    const requestId = randomUUID();
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cache-Control', 'no-store');
    if (config.secureCookies) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    try {
      // Only relative request targets; do not trust Host or forwarding headers
      // to determine the app origin, actor, or secure-cookie policy.
      if (!req.url.startsWith('/') || req.url.startsWith('//')) {
        throw new HttpError(400, 'INVALID_PATH', 'The request path is invalid.');
      }
      const url = new URL(req.url, config.origin);
      const pathname = url.pathname;
      if (pathname === '/health') {
        if (!['GET', 'HEAD'].includes(req.method)) {
          res.setHeader('Allow', 'GET, HEAD');
          throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Use GET or HEAD for health checks.');
        }
        return sendJson(res, 200, { status: 'ok' });
      }
      if (pathname !== '/api' && !pathname.startsWith('/api/')) {
        if (serveStatic) return await serveStatic(req, res, pathname);
        throw new HttpError(404, 'NOT_FOUND', 'The requested resource was not found.');
      }
      if (req.headers.origin && req.headers.origin !== config.origin) {
        throw new HttpError(403, 'ORIGIN_FORBIDDEN', 'This request must come from the app origin.');
      }
      if (req.headers['sec-fetch-site'] === 'cross-site') {
        throw new HttpError(403, 'ORIGIN_FORBIDDEN', 'This request must come from the app origin.');
      }
      if (pathname === '/api/session') {
        if (req.method === 'POST') {
          requireSameOrigin(req, config.origin);
          const body = await readJson(req);
          // Extra identity fields are deliberately ignored. Only server config
          // selects the actor; signing in cannot select a payer or account.
          return sendJson(res, 200, sessions.login(req, res, body.accessCode));
        }
        if (req.method === 'GET') return sendJson(res, 200, sessions.require(req));
        if (req.method === 'DELETE') {
          const session = sessions.require(req);
          requireSameOrigin(req, config.origin);
          sessions.requireCsrf(req, session);
          sessions.logout(req, res);
          res.writeHead(204);
          return res.end();
        }
        res.setHeader('Allow', 'GET, POST, DELETE');
        throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'This session method is not supported.');
      }
      const matches = matchRoutes(pathname);
      if (!matches.length) throw new HttpError(404, 'NOT_FOUND', 'The API route was not found.');
      const session = sessions.require(req);
      const route = matches.find((match) => match.method === req.method);
      if (!route) {
        res.setHeader('Allow', matches.map((match) => match.method).join(', '));
        throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'This route method is not supported.');
      }
      let body;
      if (!['GET', 'HEAD'].includes(req.method)) {
        requireSameOrigin(req, config.origin);
        sessions.requireCsrf(req, session);
        body = await readJson(req);
      }
      const handler = handlers[route.name];
      if (!handler) throw new HttpError(501, 'NOT_IMPLEMENTED', 'This feature is not available yet.');
      const result = await handler(Object.freeze({
        actor: session.actor, body, params: route.params, query: url.searchParams, requestId,
      }));
      return sendJson(res, 200, result);
    } catch (error) {
      if (res.destroyed || res.writableEnded) return;
      if (res.headersSent) return res.destroy();
      const expected = error instanceof HttpError;
      if (!expected) onError({ requestId, code: 'INTERNAL_ERROR' });
      // Never log request bodies, cookies, query strings, credentials, or raw
      // provider errors; correlate sanitized failures with this random ID.
      return sendJson(res, expected ? error.status : 500, {
        error: {
          code: expected ? error.code : 'INTERNAL_ERROR',
          message: expected ? error.message : 'Something went wrong. Try again.',
          requestId,
        },
      });
    }
  });
  server.maxHeadersCount = 100;
  server.keepAliveTimeout = 5000;
  return server;
}
