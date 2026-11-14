# Contract fixtures (F4)

Sample requests and responses that every slice builds against until the real
endpoint lands ("live" in the issues). Frontend work can render these;
backend work should return the same shapes.

| File | Contract | Owner |
| --- | --- | --- |
| `groups.json` | `GET /api/groups`, `GET /api/groups/:id` (members, directed debts, ledger) | A1, A4 |
| `expense-drafts.json` | `POST /api/expense-drafts`, `POST /api/expense-drafts/:id/confirm` | A2, A3 |
| `funds.json` | internal `getSpendableFunds(account)`, `reserveFunds(...)` → 409 | B4 |
| `overview.json` | `GET /api/overview?from&to` (balance, chart buckets, recent) | B3, B5 |
| `guard-events.json` | `GET /api/guard/events` | A9 |
| `errors.json` | 403 / 409 / 422 error envelope | all |

## Conventions

- Success responses are the JSON object shown; errors are
  `{ "error": { "code", "message", "requestId" } }` (F3 `server/http.js`).
- Keys are camelCase. Money is integer cents in fields ending `Cents`.
  Timestamps are ISO 8601 with offset; calendar dates are `YYYY-MM-DD`.
- The actor always comes from the session, never from a request body.
- User, account and group IDs are the stable seed IDs (`server/db/demo-ids.js`).
  Fixture-only IDs use these prefixes: expenses `5…`, Guard events `6…`,
  settlements `7…`, bank transactions `8…`.

`npm test` in `server/` checks that the fixtures parse, reference real seed
IDs, and add up (shares = total, buckets = totals, debts = totals, funds math).
Change a fixture only by agreement, and keep that test passing.
