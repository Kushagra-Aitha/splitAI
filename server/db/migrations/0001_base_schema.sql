-- 0001_base_schema.sql · F2 (Member B)
-- Base tables for every feature, in dependency order. The runner applies this
-- file once per schema, inside a transaction, with search_path set to
-- "<DB_SCHEMA>", public, so table names here are unqualified.
--
-- Conventions: uuid ids (gen_random_uuid, built into Postgres 13+), bigint
-- cents, timestamptz times. Follow-up constraints and indexes belong to each
-- feature owner's own migration file (see server/db/README.md).

-- ── 1. users + bank_accounts ─────────────────────────────────────────

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  handle        text NOT NULL UNIQUE,                -- 'maya', 'sam', ...
  display_name  text NOT NULL,
  full_name     text,
  initials      text NOT NULL,
  avatar_tone   text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- One mapped provider account per owner. B4 takes a row lock on this row
-- (SELECT ... FOR UPDATE) for every funds operation.
CREATE TABLE bank_accounts (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               uuid NOT NULL UNIQUE REFERENCES users (id),
  provider              text NOT NULL DEFAULT 'nessie',
  provider_account_id   text UNIQUE,                 -- Nessie acct_...; NULL until mapped
  provider_customer_id  text,
  nickname              text,
  account_type          text,                        -- Checking, Savings, Credit Card
  account_mask          text,                        -- last 4 digits shown in the UI
  balance_cents         bigint,                      -- provider snapshot; NULL until first sync
  available_cents       bigint,
  balance_as_of         timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

-- ── 2. bank_transactions (hypertable) + bank_import_keys ─────────────

CREATE TABLE bank_transactions (
  id                        uuid NOT NULL DEFAULT gen_random_uuid(),
  occurred_at               timestamptz NOT NULL,
  account_id                uuid NOT NULL REFERENCES bank_accounts (id),
  provider_transaction_id   text NOT NULL,           -- Nessie txn_...
  kind                      text NOT NULL,           -- purchase, deposit, transfer, withdrawal, ...
  direction                 text NOT NULL CHECK (direction IN ('debit', 'credit')),
  amount_cents              bigint NOT NULL CHECK (amount_cents > 0),
  status                    text NOT NULL,           -- pending, completed, declined, cancelled
  description               text,
  merchant_name             text,
  counterparty_account_id   text,                    -- provider ID of the other account, if any
  created_at                timestamptz NOT NULL DEFAULT now(),
  -- Unique constraints on a hypertable must include the partition column.
  PRIMARY KEY (id, occurred_at)
);

CREATE INDEX bank_transactions_account_time_idx
  ON bank_transactions (account_id, occurred_at DESC);

-- Turn bank_transactions into a hypertable when TimescaleDB is installed
-- (always on Tiger Cloud). A plain local Postgres keeps a normal table, so
-- the rest of the schema still works there.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
    BEGIN
      PERFORM create_hypertable('bank_transactions', by_range('occurred_at'), if_not_exists => TRUE);
    EXCEPTION WHEN undefined_function THEN
      -- TimescaleDB before 2.13 has no by_range(); use the older signature.
      PERFORM create_hypertable('bank_transactions', 'occurred_at', if_not_exists => TRUE);
    END;
  ELSE
    RAISE NOTICE 'timescaledb not installed: bank_transactions stays a plain table';
  END IF;
END
$$;

-- Dedupe on the provider's stable ID, never on timestamp equality. B2
-- inserts the transaction and its key in one DB transaction.
-- (No FK to bank_transactions: foreign keys into a hypertable need
-- TimescaleDB 2.16+.)
CREATE TABLE bank_import_keys (
  account_id      uuid NOT NULL REFERENCES bank_accounts (id),
  provider_key    text NOT NULL,                      -- = provider_transaction_id
  transaction_id  uuid NOT NULL,
  occurred_at     timestamptz NOT NULL,
  imported_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, provider_key)
);

-- ── 3. groups, group_members, expenses, expense_shares ───────────────

CREATE TABLE groups (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        text NOT NULL CHECK (kind IN ('roommates', 'trip')),
  name        text NOT NULL,
  tagline     text,
  starts_on   date,
  ends_on     date,
  created_by  uuid NOT NULL REFERENCES users (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_on IS NULL OR starts_on IS NULL OR ends_on >= starts_on)
);

CREATE TABLE group_members (
  group_id   uuid NOT NULL REFERENCES groups (id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users (id),
  joined_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, user_id)
);

CREATE INDEX group_members_user_idx ON group_members (user_id);

-- One row from draft to confirmed: the expense keeps its ID. In this build
-- the creator is the payer.
CREATE TABLE expenses (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id           uuid NOT NULL,
  created_by         uuid NOT NULL,                  -- payer
  merchant           text NOT NULL,
  category           text,
  total_cents        bigint NOT NULL CHECK (total_cents > 0),
  status             text NOT NULL DEFAULT 'draft'
                       CHECK (status IN ('draft', 'confirmed', 'expired')),
  source             text NOT NULL DEFAULT 'manual', -- manual, chat, bank
  expires_at         timestamptz,
  confirmed_at       timestamptz,
  -- Optional link to the payer's bank purchase. A3 adds the both-or-neither
  -- check and the unique partial index for confirmed expenses.
  bank_account_id    uuid,
  bank_provider_key  text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (group_id, created_by) REFERENCES group_members (group_id, user_id),
  FOREIGN KEY (bank_account_id, bank_provider_key)
    REFERENCES bank_import_keys (account_id, provider_key),
  CHECK (status <> 'confirmed' OR confirmed_at IS NOT NULL)
);

CREATE INDEX expenses_group_time_idx ON expenses (group_id, created_at DESC);

CREATE TABLE expense_shares (
  expense_id   uuid NOT NULL REFERENCES expenses (id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users (id),
  share_cents  bigint NOT NULL CHECK (share_cents >= 0),
  PRIMARY KEY (expense_id, user_id)
);

CREATE INDEX expense_shares_user_idx ON expense_shares (user_id);

-- ── 4. settlements + guard_events ────────────────────────────────────

-- The settlements row is the approval record. States in order:
-- reviewed → pending → posted | failed (expired for an unclaimed review).
-- hold_cents is the outgoing hold B4 subtracts from spendable funds.
CREATE TABLE settlements (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id            uuid NOT NULL REFERENCES groups (id),
  created_by          uuid NOT NULL REFERENCES users (id),
  payer_user_id       uuid NOT NULL,
  payee_user_id       uuid NOT NULL,
  payer_account_id    uuid NOT NULL REFERENCES bank_accounts (id),
  payee_account_id    uuid NOT NULL REFERENCES bank_accounts (id),
  amount_cents        bigint NOT NULL CHECK (amount_cents > 0),
  hold_cents          bigint NOT NULL DEFAULT 0 CHECK (hold_cents >= 0),
  status              text NOT NULL DEFAULT 'reviewed'
                        CHECK (status IN ('reviewed', 'pending', 'posted', 'failed', 'expired')),
  review_expires_at   timestamptz NOT NULL,
  claimed_at          timestamptz,
  provider_reference  text UNIQUE,                   -- Nessie txn_..., from server responses only
  provider_status     text,
  failure_reason      text,
  posted_at           timestamptz,
  resolved_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (group_id, payer_user_id) REFERENCES group_members (group_id, user_id),
  FOREIGN KEY (group_id, payee_user_id) REFERENCES group_members (group_id, user_id),
  CHECK (payer_user_id <> payee_user_id),
  CHECK (payer_account_id <> payee_account_id),
  CHECK (hold_cents <= amount_cents)
);

CREATE INDEX settlements_payer_account_status_idx ON settlements (payer_account_id, status);
CREATE INDEX settlements_group_time_idx ON settlements (group_id, created_at DESC);

-- Every Guard decision, with redacted context only. Links are optional: a
-- blocked proposal may have no expense or settlement.
CREATE TABLE guard_events (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id  uuid NOT NULL REFERENCES users (id),
  group_id       uuid REFERENCES groups (id),
  expense_id     uuid REFERENCES expenses (id),
  settlement_id  uuid REFERENCES settlements (id),
  decision       text NOT NULL,                      -- e.g. allowed, blocked
  reason_code    text NOT NULL,
  reason         text,
  source         text NOT NULL,                      -- e.g. assistant, settlement, expense
  context        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX guard_events_actor_time_idx ON guard_events (actor_user_id, created_at DESC);
CREATE INDEX guard_events_group_time_idx ON guard_events (group_id, created_at DESC);

-- ── 5. goals, goal_movements, bill_schedules ─────────────────────────

-- saved_cents = contributions − withdrawals, maintained by C5 under the
-- account lock. The sum over an account's goals is its goal reservation.
CREATE TABLE goals (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users (id),
  account_id    uuid NOT NULL REFERENCES bank_accounts (id),
  type          text NOT NULL CHECK (type IN ('house', 'car', 'trip', 'savings')),
  name          text NOT NULL,
  target_cents  bigint NOT NULL CHECK (target_cents > 0),
  saved_cents   bigint NOT NULL DEFAULT 0 CHECK (saved_cents >= 0),
  target_date   date,
  archived_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX goals_account_idx ON goals (account_id);
CREATE INDEX goals_user_idx ON goals (user_id);

CREATE TABLE goal_movements (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  goal_id        uuid NOT NULL REFERENCES goals (id),
  actor_user_id  uuid NOT NULL REFERENCES users (id),
  kind           text NOT NULL CHECK (kind IN ('contribution', 'withdrawal')),
  amount_cents   bigint NOT NULL CHECK (amount_cents > 0),
  request_key    text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (goal_id, request_key)
);

-- Recurring costs for Profile: explicit sandbox bills or labeled demo rows.
CREATE TABLE bill_schedules (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES users (id),
  account_id        uuid REFERENCES bank_accounts (id),
  group_id          uuid REFERENCES groups (id),
  name              text NOT NULL,
  amount_cents      bigint NOT NULL CHECK (amount_cents > 0),
  is_estimate       boolean NOT NULL DEFAULT false,
  recurrence        text NOT NULL CHECK (recurrence IN ('weekly', 'monthly', 'yearly')),
  day_of_month      smallint CHECK (day_of_month BETWEEN 1 AND 31),
  next_due_on       date NOT NULL,
  payment_method    text,
  icon              text,
  note              text,
  source            text NOT NULL CHECK (source IN ('nessie', 'demo')),
  provider_bill_id  text UNIQUE,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX bill_schedules_user_due_idx ON bill_schedules (user_id, next_due_on);
