-- C12's shared checking/card mapping; existing funds/goals keep using checking.
UPDATE bank_accounts SET account_type = 'Checking' WHERE account_type IS NULL;
ALTER TABLE bank_accounts DROP CONSTRAINT bank_accounts_user_id_key;
ALTER TABLE bank_accounts ALTER COLUMN account_type SET DEFAULT 'Checking';
ALTER TABLE bank_accounts ALTER COLUMN account_type SET NOT NULL;
ALTER TABLE bank_accounts ADD CONSTRAINT bank_accounts_user_type_key UNIQUE (user_id, account_type);
ALTER TABLE bank_accounts ADD COLUMN credit_limit_cents bigint CHECK (credit_limit_cents > 0);

CREATE TABLE capital_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  account_id uuid NOT NULL REFERENCES bank_accounts(id),
  payee text NOT NULL CHECK (char_length(payee) BETWEEN 1 AND 80),
  amount_cents bigint NOT NULL CHECK (amount_cents BETWEEN 1 AND 100000000),
  day_of_month smallint CHECK (day_of_month BETWEEN 1 AND 31),
  next_due_on date NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'deleted', 'completed')),
  request_key uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (user_id, request_key)
);
CREATE INDEX capital_schedules_due_idx ON capital_schedules(next_due_on, id) WHERE status = 'active';
CREATE INDEX capital_schedules_user_idx ON capital_schedules(user_id, created_at DESC);

CREATE TABLE capital_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  account_id uuid NOT NULL REFERENCES bank_accounts(id),
  kind text NOT NULL CHECK (kind IN ('purchase', 'withdrawal', 'card_payment')),
  payee text NOT NULL CHECK (char_length(payee) BETWEEN 1 AND 80),
  amount_cents bigint NOT NULL CHECK (amount_cents BETWEEN 1 AND 100000000),
  request_key uuid NOT NULL,
  schedule_id uuid REFERENCES capital_schedules(id),
  occurrence text CHECK (occurrence ~ '^\d{4}-\d{2}(-\d{2})?$'),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'submitting', 'unknown', 'pending', 'completed', 'declined', 'cancelled')),
  provider_reference text UNIQUE,
  failure_code text,
  claimed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (user_id, request_key),
  UNIQUE (schedule_id, occurrence),
  CHECK ((schedule_id IS NULL) = (occurrence IS NULL))
);
CREATE INDEX capital_operations_user_idx ON capital_operations(user_id, created_at DESC, id DESC);
CREATE INDEX capital_operations_unresolved_idx ON capital_operations(updated_at, id)
  WHERE status IN ('queued', 'submitting', 'unknown', 'pending');
CREATE INDEX capital_operations_user_unresolved_idx ON capital_operations(user_id)
  WHERE status IN ('queued', 'submitting', 'unknown', 'pending');

CREATE TABLE capital_merchants (
  name text PRIMARY KEY,
  provider_id text NOT NULL UNIQUE
);
