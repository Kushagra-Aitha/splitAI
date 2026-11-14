# Ask Split

C1/C2 implement `POST /api/ask` with the F3 session, exact Origin, JSON, and CSRF
requirements. Send `{ "message": "Spent $42 at Antonio’s, split with Sam and Priya.",
"requestKey": "<new UUID>" }`. Reuse that key when explicitly retrying the same
message; a different message with the same key returns `409 REQUEST_KEY_REUSED`.
For classification, only a trimmed message of 1–500 characters reaches Gemini;
identity, credentials, financial records, client context, and history are excluded.

Gemini classifies `expense`, `affordability`, `debt_summary`, `spending_insight`,
or `unsupported`. Expense fields are `merchant`, integer USD `cents`,
`participantNames`, and nullable `groupHint`. Missing values stay null or empty;
the application does not invent them. All model output is validated in code:
unknown fields, extra identities/actions, unsafe or fractional cents, wrong
types, unbounded names, and contradictory intent/expense pairs are rejected.
Names and group hints remain untrusted data, even after schema validation.

Apply migration `0300_assistant_proposals.sql` through the normal migration
runner before using C2. It stores an actor-scoped proposal, extraction, request
key, and message fingerprint; raw prompts and conversation history are not stored.
Proposals awaiting selection expire after 15 minutes. This is demo storage; no
scheduled retention cleanup is installed yet.

An expense resolves groups from A1's actor-scoped list. A unique exact group hint
or sole group is eligible; otherwise `type: "selection_needed"` returns
`GROUP_REQUIRED` with authoritative group choices. Exact display/full-name
matches must identify one current member; duplicate or unknown names return
`MEMBERS_REQUIRED`. Missing merchant, cents, or people return
`EXPENSE_DETAILS_REQUIRED`. The payer is always the session actor.

Follow up with `{ "proposalId": "<returned UUID>", "selection": {
"groupId": "<eligible UUID>", "participantIds": ["<eligible UUID>"],
"merchant": "Lunch", "cents": 4200 } }`. Only `groupId` is needed when names
and details resolve uniquely. Explicit member IDs resolve ambiguity; merchant
and cents supply missing details. Every selected person must belong to that
group. Creating a group reuses A1, then selects it through this same proposal.

C2 calls A2 inside the proposal transaction, binding exactly one real draft and
its shares atomically. Initial and selection retries recover that draft without
another model call. Conflicting final selections return
`409 PROPOSAL_ALREADY_REVIEWED`. The response is `type: "draft"`, `proposalId`,
`group`, and A's `draft`. Ask renders A5's shared ticket; only its explicit
confirmation calls A3 and adds the ledger entry. Discard hides the review and
leaves its unsaved draft to expire. Draft creation and confirmation do not
submit settlements or transfer money. A3 rechecks and locks membership for the
payer and all share members when committing; confirmed replays add no obligations.

Read classifications now use C4's actor-scoped facts and explanations.
Unsupported requests get a fixed answer. C3 will add recorded Guard
evaluation; an unsupported reply or invalid-output error is not a Guard event.

C4: `facts.js` reads A4 debts, B4 funds, and B3 spending within one
read-only, repeatable-read transaction, which ends before any model explanation.
It validates safe integer amounts, exposes the explicit New York date window,
and keeps held payments separate from spendable funds. `POST /api/ask` handles
affordability, debt summaries, and month-to-date spending questions.
`GET /api/insight?from=YYYY-MM-DD&to=YYYY-MM-DD&bucket=day|week|month` supports
the same validated ranges as B3; dates default to this month through today in
New York. Answers include `asOf`, `balanceAsOf`, and a `plan`, `debts`/`groups`,
or `spending` object. Missing bank snapshots block affordability with 409
`BALANCE_UNKNOWN`; spending facts can still be explained.

User-approved policy: whole debts only. Groups are ordered by creation time then
UUID, and debts by counterparty UUID. One running spendable balance is shared
across every group. A debt that does not fit is skipped, leaving the remaining
budget available for later smaller debts. Receivables do not increase cash.
Any debt with a hold-backed payment is marked `pending` and excluded until it
resolves; its hold is already deducted by B4 and is not deducted twice.

Gemini receives only a small set of application-computed aggregate factual
sentences, with no identities, merchant names, group notes, or transaction rows.
It selects their explanatory order using schema-constrained IDs. Code requires
every ID exactly once and renders the original sentences, so the model cannot
alter a figure, invent a claim, or propose an action. The activity window always
leads an insight. This deliberately constrains explanation wording. Both Gemini
calls share the same bounded transport and provider-use limits.

Local successful financial mutations invalidate Ask answers and Overview caches.
An older in-flight answer cannot replace the current financial state. Ask shows
snapshot timestamps and an explicit Refresh facts action for external changes.
Verify calculations, snapshot isolation, scope, and live explanation with:

```sh
node --test server/test/assistant-facts.test.js
node --test server/test/assistant-answers.test.js
RUN_FACTS_DB_TESTS=1 node --test server/test/assistant-facts.integration.test.js
npm --prefix server run smoke:insight
```

`fixtures/ask.json` contains the C1 parser-only examples;
`fixtures/ask-workflow.json` describes the current C2 HTTP workflow. Existing
A/B fixtures are unchanged; group member details add `fullName` and `handle`
so people with identical display names can be distinguished explicitly.

Set `GEMINI_API_KEY` and `GEMINI_MODEL` in `server/.env`. The client uses Google's
[structured JSON output](https://ai.google.dev/gemini-api/docs/structured-output)
through [`generateContent`](https://ai.google.dev/api/generate-content), with
no tools, a 25-second timeout, a 64 KiB response cap, and no automatic retries.
Use is limited to four concurrent calls and 30 requests/minute per API process;
these limits are shared by the configured demo actor. Provider errors, raw
responses, and prompts are not logged or included in API errors.
For `gemini-3.5-flash`, classification uses the documented `minimal` thinking
level to reduce unnecessary reasoning latency. Other models keep their defaults;
no model-specific parameter is guessed or retried on provider rejection.

Recoverable errors use the F3 envelope: invalid input 422, invalid/truncated/
blocked/model tool output 502, provider/configuration/busy failures 503, timeout
504. Ask's HTTP caller allows 60 seconds for classification plus explanation
(each provider call is capped at 25 seconds), and retains input and the request key
for explicit retries. All other API requests keep the default 15-second deadline.
The UI presents errors as escaped text, disables pending selections, and never
inserts model HTML. Monetary form input is converted using exact decimal cents.

Verification:

```sh
npm --prefix server test
npm --prefix server run smoke:ask
RUN_ASK_DB_TESTS=1 node --test server/test/ask-workflow.integration.test.js
RUN_LEDGER_DB_TESTS=1 node --test server/test/expense-membership.integration.test.js
```

The first command includes real HTTP session/CSRF tests with injected model
responses. The second sends a fixed, synthetic Antonio’s example to the real
configured Gemini model and asserts the structured fields, then checks synthetic
affordability, debt, spending, and unsupported-payment intent routing. It never reads
personal transactions, writes to the DB, or prints credentials/provider content.
Offline transport tests do not count as live Gemini verification.

Database integration tests create, migrate, seed, and drop only their uniquely
named test schemas. They verify ambiguity, participant scope, concurrent retry
binding, ledger confirmation/replay, expiry, and removed/zero-share membership.
Never point manual test writes at a shared demo schema.

Local C1 verification on 14 November 2026: 35 tests and the frontend build passed.
The live Antonio’s extraction passed with the configured `gemini-3.5-flash`.
Extended live routing runs also produced successful affordability/debt
classifications, but some read-intent requests exceeded the 25-second deadline,
including after selecting minimal thinking. A complete extended smoke run has
not passed; retain this limitation when reviewing C1. Timeout behavior is tested
and returns a recoverable 504, with no financial writes or automatic retry.

Local C2 verification on 14 November 2026: the production build and ordinary
API suite passed; the isolated Ask database suite passed all nine tests,
including atomic rollback and selecting a newly created group. A live HTTP
session using configured Gemini and isolated PostgreSQL passed Antonio's group
selection, three exact $14 shares, draft retry, explicit confirmation, and
confirmation replay. Native browser control stalled during visual verification;
the browser layout and keyboard flow remain unverified. Full mobile/accessibility
polish belongs to C7.

Local C4 verification: all/some/none, held-payment exclusion, exact cents, and
invalid model selections passed offline. Real PostgreSQL verified scoped answers
and concurrent-snapshot consistency. The live Gemini insight smoke passed using
only fixed synthetic $42 spending/$100 deposits and the explicit date window.
The ordinary suite passed 60 tests (four optional DB suites skipped), and the
production build passed. Visual browser verification remains outstanding.
