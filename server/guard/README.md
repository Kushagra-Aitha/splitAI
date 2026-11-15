# Guard v3 (C19, #113)

Guard scores every newly stored comment with a quantized
`microsoft/deberta-v3-xsmall` classifier. Explicit instruction-override,
outside-payment and credential-request rules explain a model flag but never
make the flagging decision while the model is healthy. It stores the score,
reason codes and artifact revision on the canonical comment. Identical
comment retries return their original result and never duplicate events.
Existing comments are not silently rescored or sent anywhere.

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
Comments have no path into Ask/Gemini or bank operations. If the model cannot
load, Guard logs one structured `GUARD_MODEL_FALLBACK` event and uses the
three rules as a local fallback; comment posting continues.

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

The demo uses xsmall rather than small so it can train and run on an 8 GB
M1 Mac. Create a Python 3.11 environment and, from `server/`, run:

```sh
python3 -m pip install -r guard/requirements.txt
npm run guard:train
npm run guard:eval
```

Training downloads the pinned base model and a checksum-verified public UCI
SMS corpus, then adds only the committed synthetic Split examples. It freezes
the embeddings and first six encoder layers, selects a high-precision
threshold on validation data, exports ONNX and applies int8 dynamic
quantization. Raw data, PyTorch checkpoints and the approximately 87 MB ONNX
artifact stay under `guard/.cache/` and out of git. The committed manifest
contains only model metadata and the artifact digest.

At runtime the server loads the local artifact before listening and inference
makes no network calls. `GUARD_MODEL_PATH` can point to another local export.
After publishing the export to a public Hugging Face repository,
`GUARD_MODEL_ID` enables first-start download and the Transformers.js cache.
If neither is configured, the default is
`guard/.cache/deberta-xsmall-onnx`.

The committed `evaluation.json` reports held-out precision **96.85%** and
recall **93.18%**. `guard:eval` loads the actual quantized artifact, reports
those metrics and the normal-chat false-positive rate, checks the required
Jack message, and fails if more than one of 30 normal money messages is
flagged or warm inference exceeds 300 ms. On the training M1, the quantized
model flagged Jack, flagged 0/30 normal messages, and had 9.19 ms maximum
warm inference across that set. These small synthetic/domain checks do not
prove production accuracy or catch every scam.

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
