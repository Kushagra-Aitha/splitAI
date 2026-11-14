# Database (F2)

One Tiger Cloud (TimescaleDB) service. Each member works in their own schema
inside it, set by `DB_SCHEMA` in `server/.env`:

| Who | `DB_SCHEMA` |
| --- | --- |
| Member A | `split_a` |
| Member B | `split_b` |
| Member C | `split_c` |
| Deploy (Vultr) | `split` |

## Commands (run in `server/`)

| Command | What it does |
| --- | --- |
| `npm run db:check` | Connects; shows TimescaleDB version, applied migrations, row counts |
| `npm run db:migrate` | Applies pending `migrations/*.sql` to `DB_SCHEMA` |
| `npm run db:seed` | Upserts stable demo rows (safe to rerun) |
| `npm run db:setup` | Migrate, then seed |
| `npm run db:verify` | F2 acceptance check on a throwaway `<DB_SCHEMA>_verify` schema |
| `npm run nessie:smoke` | Nessie sandbox health, key and mapped-account check (read-only) |
| `npm run nessie:demo-activity` | Creates a few real sandbox purchases, a deposit and a transfer (safe to rerun) |
| `npm run banking:read` | B1: compares normalized balance and activity with the raw Nessie response |
| `npm run banking:sync` | B2: syncs every mapped account into `bank_transactions` (`-- --verify` syncs twice and checks nothing doubled) |

To start your schema over: `DROP SCHEMA split_x CASCADE;`, then `npm run db:setup`.

## Migrations

- Files are `NNNN_snake_name.sql`, applied in filename order, each in one
  transaction, recorded in `schema_migrations` with a checksum.
- Never edit a file after it is merged. The runner refuses a changed file. Add a new one.
- Write unqualified table names; the runner sets `search_path` to `"<DB_SCHEMA>", public`.
- Number ranges, so feature branches never pick the same filename:

| Range | Owner |
| --- | --- |
| `0001`–`0099` | Foundation (F2, Member B) |
| `0100`–`0199` | Member A (groups, expenses, settlements, Guard) |
| `0200`–`0299` | Member B (banking, funds, bills) |
| `0300`–`0399` | Member C (Ask, goals) |

## Bank activity

- `bank_transactions` rows have `source = 'nessie'` (synced from the sandbox) or
  `source = 'demo'` (labeled Jun 1 – Nov 13 history for Maya, seeded by
  `db:seed` from `db/demo-history.js`, because Nessie cannot backdate).
- Dedupe is by `bank_import_keys (account_id, provider_key)`, never by
  timestamp. A resync only refreshes status (pending → completed).
- Sync writes run under `SELECT … FOR UPDATE` on the `bank_accounts` row, the
  same lock B4 uses for funds.

## Stable demo IDs

Import from `server/db/demo-ids.js`. Never change them.

- Users: Maya `…0001` (demo actor), Sam `…0002`, Priya `…0003`, Alex `…0004` (prefix `10000000-0000-4000-8000-`)
- Bank accounts: same suffixes, prefix `20000000-0000-4000-8000-`
- Puffton 4 `30000000-0000-4000-8000-000000000001`: Maya, Sam, Priya, Alex
- Boston weekend `30000000-0000-4000-8000-000000000002`: Maya, Sam, Priya
- Maya's six demo bills: prefix `40000000-0000-4000-8000-`

## Left to feature owners' migrations

- A3: both-or-neither check on `expenses (bank_account_id, bank_provider_key)` and
  the unique partial index for confirmed expenses linked to a bank transaction.
- Any further indexes or constraints for a feature belong to that feature's migration.
