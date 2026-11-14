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

Outstanding C11 dependency: matching “last night's Domino's” to a real bank
transaction requires A11 (#74). This change does not pretend that an
unlinked/manual Ask draft is a matched bank purchase. Keep #73 open until
that integration and manual drawer/keyboard/mobile acceptance are verified.

Checks: production build, backend regression suite, notification message
unit check, and isolated notification DB/session suite (including readable
canonical metadata, mark-all ownership and former-member exclusion).
No browser tests were run.
