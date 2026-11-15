# Group activity and comments (C9)

Apply `0303_group_activity.sql` after C8's migration. No new packages or
provider configuration are required. A10's group-row lock and active
membership (`left_at IS NULL`) gate every read and post, including retries.

## Contracts

- `GET /api/groups/:id/activity?limit=20&before=<nextCursor>` returns
  `{items, expense: null, nextCursor}`. Limit is 1–50; items merge confirmed
  expenses, pending/posted/failed settlements and comments newest first.
  Each item has `id`, `type`, `occurredAt`, `expenseId`, `authorUserId`,
  `authorName`, `merchant`, `amountCents`, `status`, `payeeUserId`, `payeeName`,
  `text` and `yourShareCents` (inapplicable fields are null). Public display
  names are returned without email, account or credential fields.
- Adding `expenseId=<UUID>` returns only that confirmed expense's comments
  and its summary in `expense`. Cross-group IDs and drafts return 404.
- `focusId=<UUID>&focusType=comment|expense|settlement` starts a bounded page
  at an older entry, inclusive. It cannot be combined with `before`.
  Expense threads accept only comment focus. This lets a notification open
  an old comment or settlement without fetching every intervening page.
- `POST /api/groups/:id/comments` accepts
  `{text, requestKey: "<UUID>", expenseId: "<UUID>" | null}` and returns
  `{comment: {id, groupId, expenseId, authorUserId, text, createdAt}}`.
  `expenseId` may be omitted. Text is trimmed, 1–500 Unicode code points;
  malformed Unicode and control characters other than tab/newline are
  rejected. Render it as escaped plain text, never HTML or Markdown.

The actor comes exclusively from the session. Unknown body fields are
rejected. A composite FK prevents cross-group expense links. Request keys
are unique per author and bound to the original group, expense and text;
identical retries return the original comment, conflicting reuse returns
409. There is a per-author, per-group limit of 20 new comments per minute,
serialized by the group lock. Replays do not consume that limit.

Comment and notification inserts share one transaction. Every active group
member except the author receives one reference-only notification, whether
the comment is group-wide or expense-specific. A soft leave serializes
with posting, revokes read/post access and excludes future alerts. Historical
comments remain visible to current members, including newly added members,
consistent with A10's group history. No edit/delete or retention policy is
introduced.

The feed and threads use indexes and keyset pagination retaining full
PostgreSQL microseconds plus ID/type tie-breakers. Settlement status changes
move that entry to its current activity time; a refreshed live feed is not
a frozen historical snapshot. Debt arithmetic and the financial ledger
remain unchanged. Comments have no query/input path into Ask/Gemini,
Guard execution, bank providers or settlement submission.

Together keeps an in-memory composer draft and retry key across refreshes.
It renders escaped text, provides an expense summary above its thread,
supports bounded Older/Latest pages and focuses notification destinations.
Navigation/logout discard the active group's private cache. C8's existing
visible-tab poll also invalidates the current feed when its notification
references change; C9 introduces no second polling timer. Refresh failures
retain typed text; retrying an uncertain post reuses its key.

## Verification

```sh
npm --prefix server test
npm run build
cd server
RUN_ACTIVITY_DB_TESTS=1 node --env-file=.env --test test/activity.integration.test.js
```

The focused test uses a fresh isolated schema and real HTTP sessions. It
covers Dinner $42 comments and notification recipients, unchanged financial
state, concurrent retries, cross-group links, draft/Unicode/identity input
rejection, atomic rollback, the A10 leave race, former-member exclusion,
chronology/thread/focus pagination, authentication and CSRF. It makes no
browser, Gemini or bank API calls. Browser acceptance is a manual check:
Sam opens Dinner's comments and posts; Maya sees the feed/comment alert,
opens it and lands on the expense thread. Verify that HTML-looking text
displays literally and keyboard focus and narrow-screen layout work.
