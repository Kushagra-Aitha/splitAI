# Goals UI (C6)

The page loads `GET /api/goals`; no local demo goals or saved amounts are
created. Empty, loading, error, create, contribution, withdrawal, and refresh
states use the C5 API. Dates are optional, money input uses exact decimal cents,
and savings above target remain visible while visual progress caps at 100%.

Each form retains its request key while retrying an unchanged payload. Pending
writes disable the form. A successful write is followed by a fresh goal-list
read because a replay receipt may predate later movements. Failed writes retain
the last confirmed progress; a failed refresh after a successful write explicitly
says the server saved it. Read generations reject stale responses. Local financial
changes invalidate goals, Ask answers, and Overview caches.

The existing Three.js scene receives confirmed progress. Its renderer and host
are retained for updates to the same goal; changing goals or navigating away
disposes the old scene and cancels animation frames. Contributions can play a
coin gesture once per receipt; withdrawals animate progress in reverse. Preview
controls and animation callbacks never call a mutation endpoint. Reduced motion
settles the visual state directly. A failed WebGL load leaves the numeric progress
available. Goal editing remains outside the required create/move lifecycle.

Verification:

```sh
node --test server/test/goals-store.test.js server/test/money-input.test.js
npm --prefix server test
npm run build
```

On 14 November 2026, 67 ordinary tests and the production build passed (five
optional database suites were skipped by that command). Separately, the actual
client store was checked through a local HTTP session against isolated PostgreSQL:
create at 50%, reconstruct/load the store, contribute to 60%, withdraw to 40%,
replay the old contribution receipt while staying at 40%, and reject an
over-budget contribution while preserving progress. The withdrawal released
exactly its amount in spendable funds.

Manual acceptance on 14 November 2026: the user verified that reloading the
Goals page retains $40 saved and 40% progress. Together with the real HTTP/store
checks and withdrawal/funds checks above, this covers C6's reload durability and
reservation-release acceptance checks.

Detailed visual checks for scene reuse, reverse/reduced-motion animation, keyboard
focus, and narrow-screen layout have not been separately verified. Browser
automation encountered stale-state, missing-frame, and missing-window errors.
These visual/accessibility checks remain follow-up work alongside C7; no claim
of full mobile or reduced-motion verification is made here.
