# Ask Split

C1/C2 implement `POST /api/ask` with the F3 session, exact Origin, JSON, and CSRF
requirements. Send `{ "message": "Spent $42 at Antonio’s, split with Sam and Priya.",
"requestKey": "<new UUID>" }`. Reuse that key when explicitly retrying the same
message; a different message with the same key returns `409 REQUEST_KEY_REUSED`.
Only a trimmed message of 1–500 characters reaches Gemini; identity, credentials,
financial records, client context, and conversation history are excluded.

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

Read classifications return `501 ASSISTANT_FACTS_UNAVAILABLE` until C4 has the
required actor-scoped read services. Unsupported requests get a fixed answer;
model prose is never presented as financial advice. C3 will add recorded Guard
evaluation; an unsupported reply or invalid-output error is not a Guard event.

C4 groundwork: `facts.js` reads A4 debts, B4 funds, and B3 spending within one
read-only, repeatable-read transaction, which ends before any model explanation.
It validates safe integer amounts, exposes the explicit New York date window,
and keeps held payments separate from spendable funds. Groups are ordered by
creation time then UUID. This module is not registered as an endpoint yet;
recommendation policy (whole versus partial debts) and explanation integration
remain unfinished. Verify its snapshot isolation and scope with:

```sh
node --test server/test/assistant-facts.test.js
RUN_FACTS_DB_TESTS=1 node --test server/test/assistant-facts.integration.test.js
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
504. Ask's HTTP caller allows 35 seconds and retains input and the request key
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
