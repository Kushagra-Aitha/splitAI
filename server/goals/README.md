# Goals storage groundwork (C5)

`listGoals(db, actorId)` reads active goals whose goal owner and account owner
both match the trusted session actor. Saved cents are derived from durable
contributions minus withdrawals, then checked against the cached reservation.
SQL casts monetary columns to text so unsafe integers are rejected before
conversion, independent of the global PostgreSQL bigint parser. Inconsistent
or overflowing balances return `409 GOAL_STATE_INVALID`.

This read helper is not registered as an API route yet. Creation, contributions,
withdrawals, funds locking, and mutation retry handling remain unfinished.
Target-date and over-target contribution policies await clarification. No
financial mutation or account reservation is implemented by this module.

```sh
node --test server/test/goals-read.test.js
RUN_GOALS_DB_TESTS=1 node --test server/test/goals.integration.test.js
```

The database test creates, migrates, seeds, and drops only a uniquely named
test schema. It checks actor/account scope, durable movement totals, and cached
reservation mismatches. Never run manual test writes against a shared schema.
