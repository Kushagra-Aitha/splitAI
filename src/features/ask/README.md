# C11 Ask panel, notifications and Goals

The floating Ask button opens an accessible drawer without changing the
current route or replacing its DOM. Conversation, composer and scrolling
remain in memory across close/reopen. Phone layout fills the viewport;
keyboard focus stays within the drawer and returns to its opener on close.
Expense review/group creation still uses the shared Together services.
Nested review modals take focus above the drawer, then return to it.
Navigation links close the drawer and use the existing B10 routes.

Prompt chips populate the composer; sending is explicit. Requests keep the
existing immutable retry keys, authorization and confirmation boundaries.
Logout/session changes abort requests and discard the conversation; no
conversation or credentials enter browser storage. Financial-change events
invalidate old answers without polling or rebuilding the underlying page.

Notifications now resolve public actor names, expense totals/shares and
payment direction from canonical scoped rows, rather than copying those
details into storage. Messages use exact cents, shared stable avatars and
relative times. `POST /api/notifications/read` accepts either `{ids: [...]}`
or exactly `{all: true}`. Both update only the current actor's unread,
currently visible notifications; mark-all does not acknowledge a departed
group's rows or another user's notifications. The existing C8 visible-tab
15-second timer is unchanged pending the later team refactor (#65).

Goals removes the persistent Refresh button, retains error retry, explains
that savings are set aside within the balance, and offers three starter
forms in the empty state. Selecting a starter does not create/fund anything;
the user edits and confirms the normal form. Returning to a visible Goals
tab refreshes through the existing store, with no new interval timer.

Bank matching uses B12's canonical imported purchases and A2's existing
bank-linked draft contract, so it can ship independently of A11's later
Transactions page. Explicit bank/time references such as “last night's
Domino's” search only the actor's linked accounts and Nessie purchase debits
in Pending/Completed state, excluding purchases already split. Matching is
bounded to six candidates and a specific local-date window (New York);
ambiguous results require selection. Last night/yesterday use the previous
calendar day; today/this month and a 30-day last-purchase window are also
supported. Cash requests retain the manual expense flow.

The bank supplies canonical amounts and merchant names; clients cannot
change the selected purchase's amount or choose another user's account.
The shared review ticket still requires explicit confirmation. Its bank
reference is retained on retries and in the durable proposal binding.
Matching checks the Nessie source; confirmation rechecks sharing consent, ownership, purchase status and amount;
the existing database constraint prevents splitting the same purchase
twice. Declined/cancelled or unshared purchases cannot be confirmed.
Only normalized criteria and a prompt hash are persisted. No bank rows or
account IDs are sent to Gemini, and matching initiates no bank transfer.
Migration: `0306_ask_bank_matching.sql`.

Checks: production build, backend regression suite, notification message
unit check, isolated notification DB/session suite (including readable
canonical metadata, mark-all ownership and former-member exclusion), and
isolated Ask bank-matching checks covering real card/checking references,
ambiguity, foreign IDs, immutable amounts, repeated confirmation and
declined/unshared state changes.
No browser tests were run.
