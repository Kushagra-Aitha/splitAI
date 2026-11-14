# C14 delivery status and integration contract

Independent C14 functionality is implemented on `feat/ask-reminders`:
- B13's standalone Ask route and floating panel share the same conversation/controller.
  On the Ask page, the floating opener focuses the composer instead of creating a
  second copy of the page's form IDs.
- `goal_progress` returns actor-owned saved/target/remaining values, observed net
  cents/day since creation (including initial funding), target pace and funded,
  on-track, short or no-date status. Calculations use integer cents/BigInt and New
  York calendar dates. Projections are labeled estimates, not automatic contributions.
- Debt-summary Settle up buttons open A's existing canonical settlement review;
  explicit approval is still required and reminders never invoke that service.
- Goals has persistent last-action receipts plus 20-item, keyset-paginated movement
  history. Stale history replies are discarded; failed later reads retain earlier
  pages. Overview separates goal reservations from pending payment reservations and
  names each reserved goal. No bank balance is artificially changed.
- Reminder intent extracts recipient/merchant/group hints only. The model cannot
  set the amount, authorize membership, or send a notification directly.

## Reminders

Migration `0309_debt_reminders.sql`; C13 migration 0308 is already merged on dev.

`POST /api/reminders/drafts` accepts `{groupId, recipientUserId, expenseId?, requestKey}`.
It computes the net group debt owed to the session actor, with current membership
on both sides. An optional expense must be the actor's confirmed expense with a
positive recipient share. The expense supplies context; it does not change the
net debt amount. The UI explicitly explains that distinction. Draft expiry: ten
minutes. Creation is limited to 30 new drafts/minute per sender; retries reuse
immutable terms and do not consume another slot.

Ask resolves authorized matching expenses with bounded candidate queries (maximum
six results). An unmatched merchant nickname offers explicit authorized choices
instead of silently selecting an unrelated expense. Ambiguity returns `reminder_selection`; choosing a candidate prepares a
`reminder_draft`. Zero candidates does not silently choose another person/debt.

`POST /api/reminders/:id/confirm` accepts exactly `{}`. The authenticated sender
must still be a current member; the recipient must be current, the debt must
remain exactly the reviewed amount, and no outgoing settlement for it may already
be pending. Only explicit confirmation changes status and inserts the notification
in the same transaction. The unique daily key is sender/recipient/group/New York
calendar day, independent of which related expense is selected. Replaying one
successful confirmation returns the original result without a second alert;
confirming another draft for that debt/day returns 429. Notification failure
rolls back status/daily-limit consumption.

Notification storage contains references only. `debt_reminder` presentation resolves
sender name, group, related expense merchant and reminder's confirmed amount from
canonical rows. The recipient sees its own currently membership-authorized items.
The text says "$X owed in Group · related to Merchant" so it cannot imply that a
net balance across several expenses is an unpaid balance on just one purchase.
B16's grouped, clickable panel remains in place. No new polling was added.

## A16 dependency still open

Issue #91 supplies the reusable charge-explanation service needed for "Explain
the Domino's charge." This branch does not duplicate that service or claim C14
fully complete. Add that integration after A16 lands, retaining canonical facts,
current membership/ownership and its deterministic provider-unavailable fallback.
No Gemini key, account ID or bank transaction rows are added to model input here.

## Verification and limitations

Ordinary backend regression and production build pass. Focused DB suites cover
confirmed reminder concurrency/replay, daily limits across different expenses,
changed debt, expiry, departed recipient, ambiguity and scoped/paginated goal
history. Existing goal mutation and notification suites pass after fixture
updates for explicit B12 sharing and current metadata fields. A further focused
case covers pending payment suppression and atomic notification rollback.
No browser acceptance is claimed. Gemini quota was exhausted at the last live
probe; injected structured-output checks do not certify live provider availability.
