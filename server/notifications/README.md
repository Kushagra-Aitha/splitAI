# Notifications (C8)

Apply migration `0302_notifications.sql` with the normal migration runner.
The existing authenticated session, same-origin and CSRF rules apply. There
is no recipient selector in either public endpoint.

- `GET /api/notifications?limit=20&before=<nextCursor>` returns
  `{items, unreadCount, nextCursor}`. Limit is 1–50. Each item contains only
  `id`, `kind`, `sourceId`, `groupId`, `expenseId`, `groupName`, `createdAt`
  and `readAt`. `unreadCount` covers all currently visible unread items,
  including when paging older entries. Cursors retain PostgreSQL microseconds.
- `POST /api/notifications/read` accepts `{ "ids": ["<notification UUID>"] }`
  (1–100 IDs), returns `{acknowledged: true}` and marks only owned, currently
  visible items read. Foreign, missing and former-group IDs behave alike;
  repeated reads retain the first `read_at`.

`notify(tx, {kind, sourceId})` takes the event's existing transaction and
derives recipients from stored rows in one bulk insert. Its uniqueness key
is `(recipient_user_id, kind, source_id)`, so retries do not duplicate alerts.
Expense recipients are active share participants other than the creator,
including zero-cent shares. Settlement recipients are the active payer and
payee. Guard blocks are private to the actor, without group/context payloads.
The comment kind is reserved for C9's comment transaction.

No raw comments, merchant descriptions, Guard reasons, account data, emails
or provider payloads are copied into notification storage. Every page,
unread count and read update rechecks `group_members.left_at IS NULL` for
group notifications. Leaving hides those notifications. Rejoining restores
access to group history, consistent with A10's retained membership rows.

Expense confirmation and Guard rejections commit their notifications
atomically. A settlement claim alone does not mean sent: that alert waits
for a provider acknowledgement or a matching reconciliation record. Posted
and failed alerts share the transaction that records that terminal state.
An ambiguous provider failure leaves the pending hold and emits no false
success alert. No provider calls were added by this feature.

The bell polls every 15 seconds while visible, with no overlapping GETs;
errors back off to 30 seconds. Hiding the tab aborts the read and stops the
timer. Logout or actor change aborts requests and discards cached items.
Opening an item acknowledges only that item and navigates to its group and
expense/settlement, or the actor's Guard page. Responses are not persisted
in browser storage. The list has bounded pages, keyboard controls, status
text and escaped labels; navigating returns focus to the relevant entry.

Verification:

```sh
npm --prefix server test
npm run build
cd server
RUN_NOTIFICATIONS_DB_TESTS=1 node --env-file=.env --test test/notifications.integration.test.js
```

The DB test creates and drops a fresh random schema. It exercises real
sessions, cross-user/CSRF boundaries, A10 soft leave, atomic rollback,
confirmation retries, zero-cent participation, settlement acknowledgement,
terminal reconciliation and microsecond pagination. Provider responses are
injected, so it sends no bank transactions. Browser acceptance remains a
manual check: sign in as Sam and Maya in separate browser profiles, confirm
an expense containing Maya, wait up to 15 seconds in Maya's visible tab,
then open its notification and verify its read state and destination.
