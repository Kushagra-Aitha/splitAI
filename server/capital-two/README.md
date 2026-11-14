# Capital Two — C12 (#70)

The `/bank` page shares Split's authenticated session and uses real Nessie
sandbox accounts and transactions. It is a separately styled, lazy-loaded
bank screen. No provider key, full account number or card credential is sent
to the browser. Purchase/payment forms require explicit confirmation.

## Current status

Implemented: checking/card provisioning, presets/custom purchases, cash
withdrawals, payments to businesses now/on a date, fixed monthly schedules,
pause/resume/delete, repeat-safe Run now, manual checking-to-card repayment,
recent transactions, masked animated cards and reduced-motion handling.

Automatic card-bill repayment is deferred at the user's request until an
end-user preference flow is defined. It is separate from fixed recurring
payments and is not silently enabled.

**Live acceptance limitation:** the real Nessie sandbox returned/stayed
pending for the disposable test's card purchase after attempts to settle
early. Retrying made exactly one purchase. The feature preserves Pending
and reconciles the existing provider reference; it does not fake completion
or resubmit. Instant posting/card posted-balance acceptance is not verified.
The disposable customer's accounts and the test DB schema were removed.
Keep #70 open until this provider behavior is resolved and the live flow
and browser acceptance are verified.

## Member B integration contract

Migration `0304_capital_two.sql` changes `bank_accounts` from one row per
user to unique `(user_id, account_type)`, defaults null/omitted types to
Checking, and adds nullable `credit_limit_cents`. C12 provisions one
Checking account and one Credit Card for the same provider customer.
Existing checking IDs and goal/settlement references stay intact.

The existing `getMappedAccountForUser()` and `accountIdForUser()` explicitly
select Checking. B9 provisioning's lookup/conflict target also uses the
Checking type. `listMappedAccounts()` already returns both accounts, so
the batch sync CLI can consume them. B12 can expand its actor sync and
analytics to include card purchases; checking remains the cash/spendable
source. Repayment is a transfer recorded on both accounts, not a purchase.

Schedules live in `capital_schedules`; each occurrence creates a
`capital_operations` row with `schedule_id`, `occurrence` and its unique
`provider_reference`. B12/A14 can join an imported transaction's
`provider_transaction_id` to that reference to obtain its recurring rule
without guessing from amount or merchant. These tables are separate from
the labeled demo `bill_schedules` rows. No automatic group split is created.

C12 follows B12's current 20-second visible-tab refresh specification.
The worker also checks due/recoverable work every 20 seconds, without
overlapping ticks. The observer/SSE refactor remains a team follow-up (#65).

## API

All routes use existing session, Origin and CSRF protections. Identity is
always the session actor; source accounts must belong to that actor.

- `GET /api/bank`: saved `{accounts, schedules, operations, transactions,
  presets}`. Lists are bounded (100 schedules, 30 operations, 40 transactions).
- `POST /api/bank/connect` with `{}`: explicitly provision/recover checking
  and card, refresh, return the same summary. Card limit is $5,000; checking
  uses B9's $1,500 sandbox opening balance. Provisioning recovers a card by
  full actor UUID nickname on the same customer after a lost response.
- `POST /api/bank/sync` with `{}`: refresh both owned accounts and return
  the summary. Concurrent refreshes for one actor share a promise.
- `POST /api/bank/operations`: `{accountId, kind, payee?, amountCents,
  requestKey}`. Kinds: `purchase`, `withdrawal`, `card_payment`. Purchases
  require a merchant/business payee; withdrawals use an ATM descriptor;
  card repayment can originate only from Checking and targets the actor's
  own card. Amounts are integer cents from 1 to 100,000,000. Returns
  `{operation}`. No arbitrary external account transfer endpoint is exposed.
- `GET /api/bank/operations/:id`: the actor's saved operation only.
- `POST /api/bank/schedules`: `{accountId, payee, amountCents, requestKey,
  dayOfMonth}` for fixed monthly payments, or `dueOn: YYYY-MM-DD` instead
  of `dayOfMonth` for a dated payment. Returns `{schedule}`.
- `POST /api/bank/schedules/:id` with `{action: pause|resume|delete}`.
  Delete is soft; queued unsent occurrences are cancelled on pause/delete.
  A payment already submitted to the bank cannot be undone by pausing.
- `POST /api/bank/schedules/:id/run` with `{}` returns `{operation}`.
  Run now consumes the current monthly occurrence, so repeated clicks do
  not pay future months early. Dated-payment retries recover their original
  operation even after the schedule is marked completed.

## Retry, scheduling and failure rules

An actor/request key binds to immutable terms. Conflicting reuse returns
409. Operations commit before any transaction POST. A conditional queued
→ submitting claim chooses one sender across requests/processes. Nessie
transaction POSTs use no automatic retries. An opaque operation reference
in the provider description permits exact matching by account, kind,
amount and reference after a lost response. The UI strips this reference
from its transaction descriptions.

Nessie currently has no native create idempotency key. A timeout or 5xx
therefore becomes Unknown, not a new send. Recovery adopts one exact
provider match; no match or multiple matches remain unverified without
resending. Known provider IDs may be read/settled again, never re-created.
Definitive creation rejection becomes Declined. A settle error leaves the
created payment Pending. There is deliberately no unconditional
exactly-once claim across two independent databases. New actor payments
are limited to 30/minute and 100 unresolved; existing retries still recover.

Occurrences are unique by schedule and local date/month. Scheduling uses
America/New_York; days 29–31 clamp to the month's final date. A late worker
executes the oldest due occurrence once and resumes the next future date;
it does not silently charge an entire missed backlog after downtime.
Schedules survive restart, and all schedule state/occurrence creation is
serialized on its row. At most five schedules/operations are handled per
tick. API and worker errors contain no raw provider payloads. No bank action
calls Ask/Gemini or bypasses the group settlement approval flow.

## Checks

```sh
npm --prefix server test
npm run build
cd server
RUN_CAPITAL_DB_TESTS=1 RUN_PROVISION_DB_TESTS=1 node --env-file=.env --test test/capital.integration.test.js test/provision.integration.test.js
```

The isolated DB/provider tests cover multi-account provisioning races,
checking-only funds selection, one charge across concurrent retries, card
debt and repayment, response loss, acknowledgement persistence failure,
restart recovery, settle failures, rejection, occurrence deduplication,
pause/delete, short-month dates, sessions, CSRF and cross-user access.
They do not claim real Nessie instant settlement or browser verification.
