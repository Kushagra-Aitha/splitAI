# Split AI API foundation

F3 supplies the HTTP server, session boundary, route mounts, same-origin
frontend serving, and a live Gemini connectivity check. C1 adds the validated
Ask intent parser and API handler; see [assistant/README.md](assistant/README.md).
The Ask handler does not write financial records or submit payments.

Use Node 22.15 or newer (Node 24 recommended). The backend has its own dependency
manifest; it does not change the frontend lockfile. Its one dependency is `pg`.

Database (F2): Tiger Cloud connection, migrations, stable demo IDs and seed,
plus the Nessie smoke check are documented in [db/README.md](db/README.md).
B8 replaced the shared demo access code with email/password accounts stored
in Tiger Data (`users.email`, `users.password_hash`, `sessions`).

## Run locally

From the repository root:

```sh
cp server/.env.example server/.env
```

Set `DEMO_PASSWORD` (8+ characters) in `server/.env`, then run
`npm --prefix server run db:setup`. The seed gives `maya@split.test`,
`sam@split.test`, `priya@split.test` and `alex@split.test` that password.
Anyone else creates an account on the Sign up screen. Configure Gemini locally
for the live check. Never commit credentials or use `VITE_` provider variables.

```sh
npm run build
npm --prefix server start
```

Open **http://localhost:3001**, the exact `APP_ORIGIN`, and log in or sign up. The Node server serves both `dist/` and `/api/` on that origin.
Rebuild after frontend edits. For hot reload, use two terminals instead:

```sh
APP_ORIGIN=http://localhost:5173 npm --prefix server run dev
npm run dev
```

Open **http://localhost:5173**. The Vite development proxy forwards `/api` and
`/health` to port 3001 without rewriting the request origin. The environment
override takes precedence over `server/.env`. The proxy is local development
wiring; the built application uses the single Node origin directly. F3 does
not edit B's deployment configuration or A's feature extraction.

If port 3001 is occupied, set `PORT=3002` for the API and `SPLIT_API_PORT=3002`
for Vite. In built mode, also change `APP_ORIGIN` to `http://localhost:3002`;
in Vite mode it remains `http://localhost:5173`.

## Session and security contract

- `GET /health` (also HEAD) returns `200 {"status":"ok"}` without authentication.
  This is liveness only; it does not probe the database, Nessie, or Gemini.
- `POST /api/auth/signup` `{name, email, password}` and `POST /api/auth/login`
  `{email, password}` require the exact `Origin: APP_ORIGIN`. Each issues a
  random, HttpOnly, SameSite=Strict cookie and returns
  `{actor: {userId, displayName}, csrfToken, expiresAt}` (`expiresAt` is Unix
  time in milliseconds). The actor is the account that signed in; body
  `userId`, payer, and account fields are ignored. Emails are lowercased;
  passwords need 8+ characters and are stored as salted scrypt hashes.
  Sign-up returns `409 EMAIL_TAKEN` for a registered email. A wrong password and
  an unknown email both return the same `401 INVALID_CREDENTIALS`.
- `POST /api/auth/logout` (also `DELETE /api/session`) requires origin and, when
  a session exists, its CSRF token; it deletes the session and clears the cookie.
- `GET /api/session` returns the current session or 401. The frontend initializes
  through it; `src/api/session.js` exports `getSession()` and `apiRequest()` for
  feature integrations. No credentials or session state are put in localStorage.
- Every mounted feature route requires a valid session. Every mutation also
  requires the exact origin, a JSON object, and `X-CSRF-Token` from that session.
  Mutations with no fields send `{}`. Request bodies are limited to 16 KiB.
- Sessions last seven days and live in the `sessions` table, keyed by the
  SHA-256 of the cookie token, so they survive restarts and multiple processes.
  Sign-in and sign-up attempts are limited to 10 per minute per socket IP
  (forwarding headers cannot bypass this), and 5 wrong passwords lock that
  email for 15 minutes. Behind a proxy the IP limit is shared; B7 should add an
  edge limit if needed.
- `createApp({ config, handlers, authStore })` requires an auth store:
  `createDbAuthStore` in the server, `createMemoryAuthStore` in tests
  (`test/support/auth.js` has `memoryAuth()` and `loginAs()`).
- Production requires an HTTPS `APP_ORIGIN`. HTTPS enables a `__Host-` cookie,
  Secure, and HSTS. Terminate HTTPS at B7's reverse proxy and forward to this
  listener; the app does not trust forwarded headers. Keep the listener private.
- API responses use `no-store`. Errors contain `{error: {code, message,
  requestId}}`. Unknown routes return 404, unsupported methods 405, missing
  session 401, scope/origin/CSRF failures 403, invalid JSON 422, oversized bodies
  413, and unsupported content types 415. Feature input validation and 409 money
  conflicts will be supplied by their owners.
- Each person signs in as themselves; `context.actor` is that account. This is a
  sandbox login, not a real bank login. Feature owners must authorize groups,
  goals, drafts, reviews, and accounts against `context.actor` and enforce
  immutable reviewed payment terms.

## Feature integration seam

`routes.js` lists the agreed endpoints for groups, expense drafts, settlement
reviews, settlements, Guard, banking, Overview, Ask, insight, and Goals. Unimplemented routes
return **501 NOT_IMPLEMENTED** after authentication until their owner registers
a handler. Unregistered endpoints never return fake success or perform writes.

`createApp({ config, handlers, serveStatic })` accepts named async handlers:

```js
const handlers = {
  'goals.list': async ({ actor, query, requestId }) => {
    return goalsService.listForActor(actor.userId);
  },
};
```

The immutable context contains `actor`, `params`, `query`, `body`, and
`requestId`. Do not derive identity from body, query, headers, or Gemini output.
Return a JSON value on success; throw `HttpError(status, code, safeMessage)` for
expected failures. Unexpected errors return a generic 500 and only a sanitized
request ID is logged. Never put credentials, raw prompts, or provider payloads
in errors. F4 will finalize feature payload shapes and migration ownership.

## Verification

```sh
npm --prefix server test
npm run build
npm --prefix server run smoke:gemini
```

The test suite uses real local HTTP requests for session, tampering, CSRF,
placeholder routes, errors, and same-origin static serving. Gemini tests use an
injected transport to exercise failure handling. They do **not** count as the
live smoke check.

The smoke CLI sends only a fixed `SPLIT_AI_OK` request to Google's
[`generateContent` REST endpoint](https://ai.google.dev/api), with
`x-goog-api-key`, no tools or user data, a 15-second timeout, and bounded output.
Set `GEMINI_API_KEY` and an available `GEMINI_MODEL` in `server/.env`; the example
uses the model shown in the current REST reference. Failure exits nonzero;
success prints only `{"status":"ok","model":"..."}`. It is intentionally not
a public endpoint and is not called by health checks. Record actual live success
before marking F3's Gemini check complete. F3 does not claim C1 extraction.

Node's [HTTP API](https://nodejs.org/docs/latest-v24.x/api/http.html) documents
the request/header timeouts used by the server.
