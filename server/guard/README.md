# Guard v2 (C10, #75)

Guard scores every newly stored comment locally with a bounded Naive Bayes
classifier plus explicit instruction-override, outside-payment and
credential-request rules. It stores the score, reason codes and artifact
revision on the canonical comment. Identical comment retries return their
original result and never duplicate events. Existing comments are not
silently rescored or sent anywhere.

A flagged comment retains its escaped plain text and shows a warning with
fixed explanations in the A12 thread/chat drawer. In the same comment
transaction, each other current member with personal comment alerts enabled
gets a private Guard log entry and one reference-only `guard_flagged`
notification. That replaces their ordinary comment notification, avoiding
duplicate alerts. Members with comment alerts off still receive the normal
comment notification and can see group warning badges. New notification
links open the relevant thread/drawer. No raw comment enters notification
storage or a second audit context copy.

The alert toggle is per user and persisted in `guard_settings`. It never
disables another member's alerts, group warning badges, session/scope checks,
or required payment approval. This classifier is advisory: neither a ham
score nor a warning authorizes, initiates, blocks or rewrites a payment.
Comments have no path into Ask/Gemini or bank operations. If the local
model cannot load, new comment writes return a safe 503 and roll back.

## Guard API and UI

- `GET /api/guard/events?filter=flagged|held|blocked|approved|all&limit=20&before=<cursor>`
  returns `{events, summary: {flaggedThisWeek}, nextCursor}`. Limits are 1–50;
  keyset cursors preserve PostgreSQL microseconds. The default `all` keeps
  the old read contract compatible. Held means an approved settlement still
  pending; its state comes from the settlement, not classifier output.
- `GET /api/guard/settings` returns `{enabled: boolean}` (default true).
- `POST /api/guard/settings` accepts exactly `{enabled: boolean}`.
- `POST /api/guard/events/:id/feedback` accepts exactly `{label: "ham" | "spam"}`.
  Only that event's recipient, while still a current group member, can label
  its comment. Financial/assistant approval events cannot be labeled spam.

Every route uses the existing session, same-origin and CSRF protections.
Comment context and feedback become unavailable after leaving the group.
Private fixed-description assistant block events remain the actor's own
history. The page has Flagged/Held/Blocked/Approved tabs, context, personal
alert toggle, Not spam/Report, and comment navigation. Opaque event IDs stay
in the database/API for audit and idempotency, without a visible Event ID
line. Not spam hides that personal alert from Flagged and its weekly count;
it does not delete evidence or suppress anyone else's warning.

Feedback stores just the event reference, actor and label. It is **not**
automatically used for online learning or exported to a provider/repository.
Future retraining from application feedback requires a separately reviewed,
consented data workflow. The committed training scripts read only public
SMS data and the hand-written synthetic examples.

## Reproducible local model

From the repository root or `server/`:

```sh
npm run guard:train
npm run guard:eval
```

Training needs Python 3's standard library to download a pinned public ZIP;
inference and evaluation use Node without added packages. The corpus hash
is verified before caching. The raw dataset is ignored by git, with private
filesystem permissions. Emails, URLs and numeric identifiers are replaced
before feature extraction. The committed `model.json` contains bounded
token/bigram weights, priors, threshold and a revision digest, not complete
messages. It is loaded once server-side; inference makes no network calls
and examines at most 160 features per comment.

Normalized duplicates are removed before splitting. SHA256 of normalized
text fixes the public-data train/validation/test partitions (60/20/20);
synthetic scenario partitions are explicit and checked for cross-partition
duplicates. Vocabulary and weights use training only. Threshold selection
prioritizes precision on validation, including the Split validation subset;
it does not choose a threshold using individual test examples. The rules
include the issue's stated attack patterns, so the hand-written benchmark
is a functional/domain check, not an independent real-world scam study.

The committed `evaluation.json` reports the complete confusion matrices:
1,071 test messages, 110 true flags, 1 false flag and 22 missed spam messages;
precision **99.1%**, recall **83.3%**. The 18 synthetic Split test cases have
8 correct flags and 10 correctly unflagged comments. The required Jack
payment/instruction example is flagged with reasons; “Thanks Ben, paying
you now” is not. These datasets do not prove production accuracy or catch
every scam. Precision/recall must continue to be monitored on reviewed,
consented feedback. `guard:eval` fails if test precision falls below 95% or
there are too few positive detections to make a vacuous success claim.

## Verification

```sh
npm --prefix server test
npm run build
cd server
RUN_GUARD_V2_DB_TESTS=1 RUN_ACTIVITY_DB_TESTS=1 RUN_LEDGER_DB_TESTS=1 node --env-file=.env --test test/guard-v2.integration.test.js test/activity.integration.test.js test/expense-membership.integration.test.js
```

The DB checks use isolated schemas and verify atomic scoring/alert fanout,
retries, no outbound model/payment calls, settings persistence, unchanged
financial state, scoped feedback, membership revocation, CSRF and rollback.
No browser tests were run. Manual checks should cover the flagged comment
badge in an A12 thread/drawer, notification destination, Guard tabs/toggle,
feedback persistence and phone/keyboard interaction.
