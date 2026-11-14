# Shared expense confirmation

Before confirming a draft, the existing actor/expiry checks run, then the server
rechecks that the payer and **every expense-share participant** are current
members of that expense's group. This includes participants assigned zero cents.
Membership in a different group does not authorize the participant here.

The recheck takes PostgreSQL key-share locks on the matching membership rows in
the confirmation transaction. A member cannot be removed between the check and
commit. If any membership is missing, confirmation returns
`403 PARTICIPANT_NOT_A_MEMBER`, rolls back, and leaves the draft and debts
unchanged. It makes no provider transfer call.

Replaying an already-confirmed expense still returns the original result without
creating another obligation. A later membership change does not retroactively
invalidate that historical confirmation.

From the repository root, run:

```sh
RUN_LEDGER_DB_TESTS=1 node --test server/test/expense-membership.integration.test.js
```

This test uses the real PostgreSQL connection from `server/.env`. Each run creates
a fresh, randomly named test schema and removes only that schema afterward. It
checks valid confirmation/replay, removed members, zero-cent shares, unchanged
debts after rejection, and concurrent membership deletion. It never calls Nessie
or modifies the configured working schema. Without the flag, the database test
is skipped by the ordinary unit-test command.
