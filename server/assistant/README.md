# Ask Split

C1 implements `POST /api/ask` with the F3 session, exact Origin, JSON, and CSRF
requirements. Send `{ "message": "Spent $42 at Antonio’s, split with Sam and Priya." }`.
Only a trimmed message of 1–500 characters reaches Gemini; identity, credentials,
financial records, client context, and conversation history are excluded.

Gemini classifies `expense`, `affordability`, `debt_summary`, `spending_insight`,
or `unsupported`. Expense fields are `merchant`, integer USD `cents`,
`participantNames`, and nullable `groupHint`. Missing values stay null or empty;
the application does not invent them. All model output is validated in code:
unknown fields, extra identities/actions, unsafe or fractional cents, wrong
types, unbounded names, and contradictory intent/expense pairs are rejected.
Names and group hints remain untrusted data, even after schema validation.

An expense currently returns `type: "selection_needed"` with its extraction,
`missingFields`, and `EXPENSE_DETAILS_REQUIRED` or `GROUP_AND_MEMBERS_REQUIRED`.
These are extraction responses, not persisted drafts or confirmation tokens.
C2 owns group/member resolution and connects A's draft service and shared ticket.
It will return a real `draft` only after authorized resolution. Only A3's explicit
confirmation commits the expense. No C1 code imports a DB or banking client,
creates a financial row, exposes tools, or submits a settlement.

Read classifications return `501 ASSISTANT_FACTS_UNAVAILABLE` until C4 has the
required actor-scoped read services. Unsupported requests get a fixed answer;
model prose is never presented as financial advice. C3 will add recorded Guard
evaluation; an unsupported reply or invalid-output error is not a Guard event.

`fixtures/ask.json` contains the C1 contract examples. Existing A/B fixtures and
API contracts are unchanged. C2 will extend these Ask variants when A2/A3/A5 land.

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
504. C2's HTTP caller must allow more than 25 seconds for Ask, rather than using
the session client's default 15-second deadline, and retain input for an explicit
retry. C1 does not persist drafts, so
retries cannot create duplicate financial records. C2 must reuse A's repeat-safe
draft/confirmation contracts before introducing writes.

Verification:

```sh
npm --prefix server test
npm --prefix server run smoke:ask
```

The first command includes real HTTP session/CSRF tests with injected model
responses. The second sends a fixed, synthetic Antonio’s example to the real
configured Gemini model and asserts the structured fields, then checks synthetic
affordability, debt, spending, and unsupported-payment intent routing. It never reads
personal transactions, writes to the DB, or prints credentials/provider content.
Offline transport tests do not count as live Gemini verification.

Local verification on 14 November 2026: 35 tests and the frontend build passed.
The live Antonio’s extraction passed with the configured `gemini-3.5-flash`.
Extended live routing runs also produced successful affordability/debt
classifications, but some read-intent requests exceeded the 25-second deadline,
including after selecting minimal thinking. A complete extended smoke run has
not passed; retain this limitation when reviewing C1. Timeout behavior is tested
and returns a recoverable 504, with no financial writes or automatic retry.
