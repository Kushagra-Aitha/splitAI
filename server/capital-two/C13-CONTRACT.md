# C13 bank flow and salary contract

Migration: `0308_capital_salary_categories.sql`. Apply before deploying this code.

Merchant presets now contain only `payee` and `category`; the user enters every
purchase amount. Purchase operations require one category from `GET /api/bank`'s
`categories`. The category binds to the retry key alongside amount/account/payee.
The receipt's View in Split action retains C12's immediate Pending purchase review.

Salary uses the existing schedule routes with:

```json
{"kind":"salary","accountId":"<owned checking UUID>","payee":"Employer","amountCents":100000,"frequency":"biweekly","dueOn":"2026-12-01","requestKey":"<UUID>"}
```

Frequency is `monthly` or `biweekly`. `dueOn` is the first deposit date. Salary is
checking-only; the operation kind is `deposit`, direction credit, category `Salary`.
The create endpoint for one-off operations does not accept arbitrary deposits.

Schedules persist `kind`, `frequency`, `first_due_on`, `next_due_on`, `day_of_month`
and category. Monthly dates retain the original day through short months.
Biweekly periods are anchored to the first date, not the latest click. Run now
consumes one anchored current period (or the first period if it has not begun).
Repeated/concurrent clicks recover that same operation. A late worker executes
one oldest due period then advances to a future date, without a catch-up flood.
Pause/delete cancel only unsent work; submitted credits still reconcile. Resume
skips overdue periods. The existing bounded worker/cadence is unchanged.

## B15 integration

- `capital_operations.category` is the bank-authored category. Shared import
  reapplies it for the receipts being synced, preserving it across merchant reads.
  B15 must store user overrides separately and compute effective category as
  override first, bank category second. Do not overwrite the bank category with an
  override or reverse that precedence on another screen.
- Match receipts through `(account_id, provider_reference)` on operations and
  `(account_id, provider_key)` on `bank_import_keys`. There is no amount/name guess.
- Salary is `o.kind = 'deposit' AND o.category = 'Salary'`; its employer is `o.payee`.
- Explicit recurring metadata joins `o.schedule_id` to `capital_schedules`.
  A recurring schedule has a monthly day or salary kind; a dated one-time purchase
  is not recurring. Summary receipts expose `isSalary` and `isRecurring`.
- Next paycheck: choose the actor's active `kind = 'salary'` schedules ordered by
  `next_due_on` and stable ID. Do not use paused/deleted rules or unshared accounts
  in Split. Salary history remains attributable after pausing/deleting a rule.
- A14 accepts purchase schedules only; monthly salary cannot become an expense
  split rule. Pending/completed bank purchases still use normal explicit review.

## Remaining product decision

Variable credit-card-bill autopay was previously deferred by the user. C13's new
issue mentions it in Scheduled. No automatic card payment is enabled here; manual
repayment remains available and the bank UI says so. Resolve that scope before
closing every C13 checkbox. Do not create a misleading functioning autopay toggle.

## Verification

Unit/date checks and build passed. Focused database/provider checks: 20 passed,
including salary loss recovery, concurrent Run now, scheduler races, category
persistence, monthly/biweekly anchors and checking ownership. Backend regression:
92 passed, 14 gated suites skipped. No browser acceptance was performed.

Live Nessie: a disposable customer received exactly one $1 deposit across Run now
retries; its Pending credit was immediately imported as Salary. The disposable
customer and database schema were removed. This is not proof of instant posting.
