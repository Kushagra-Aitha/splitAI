# Goals (C5)

`listGoals(db, actorId)` reads active goals whose goal owner and account owner
both match the trusted session actor. Saved cents are derived from durable
contributions minus withdrawals, then checked against the cached reservation.
SQL casts monetary columns to text so unsafe integers are rejected before
conversion, independent of the global PostgreSQL bigint parser. Inconsistent
or overflowing balances return `409 GOAL_STATE_INVALID`.

Apply `0301_goal_requests.sql` through the migration runner before using writes.
All three routes use F3's session, JSON, Origin and CSRF boundary:

- `GET /api/goals` returns `{ goals: [...] }`.
- `POST /api/goals` accepts `{ name, type, targetCents, initialCents?, targetDate?, requestKey }`.
- `POST /api/goals/:id/movements` accepts `{ kind: 'contribution' | 'withdrawal', cents, requestKey }`.

Request keys must be UUIDs. Amounts are safe integer USD cents; target and
movement amounts are positive, initial funding defaults to zero. Names are
1–45 characters, types are `house`, `car`, `trip`, or `savings`. User-approved
policy: dates are optional real calendar dates; savings may exceed the target
when funds permit. The session chooses the account; client identity/account
fields are rejected. There is no edit, delete, or provider transfer operation.

Every write acquires B4's account lock before checking state and retains it
through commit. Contributions use B4 `reserveFunds` inside that transaction.
Withdrawals use the same lock, cannot exceed durable savings, and release the
reservation without changing the provider balance. Every goal on the account
must have cached savings equal to its durable movements before a new write.
Goal creation and its optional initial contribution are atomic.

Writes return `{ goal, movement, funds }`; `movement` is null for zero-funded
creation. Creation retries are unique by actor/request key; movement retries
are unique by goal/request key. Identical retries return the original receipt,
even after later movements. Changed payloads with the same key fail with 409
`REQUEST_KEY_REUSED`. Refresh the goal list after a successful retry to get
current balances rather than treating an old receipt as current state. An old
historical movement without a stored receipt cannot be safely replayed and
returns `GOAL_STATE_INVALID`.

Scope violations return 403. Invalid input returns 422. Insufficient spendable
funds, unknown bank balance for a contribution, excessive withdrawals, and
inconsistent saved state return 409 without partial writes. Withdrawals remain
possible without a synced bank balance because they release an existing hold.

```sh
node --test server/test/goals-read.test.js
node --test server/test/goals-input.test.js
RUN_GOALS_DB_TESTS=1 node --test server/test/goals.integration.test.js
RUN_GOALS_DB_TESTS=1 node --test server/test/goals-mutations.integration.test.js
```

The database test creates, migrates, seeds, and drops only a uniquely named
test schema. It checks actor/account scope, durable movement totals, and cached
reservation mismatches. Never run manual test writes against a shared schema.

The mutation suite also checks concurrent retries, conflicting keys, rollback
after a receipt failure, over-target funding, withdrawal bounds, HTTP auth/CSRF,
account-level contribution races, and C4 affordability before/after goal holds.
Its settlement race uses the real B4 reservation and a synthetic hold write;
full SEC4 evidence still requires A7's real settlement operation after it lands.
