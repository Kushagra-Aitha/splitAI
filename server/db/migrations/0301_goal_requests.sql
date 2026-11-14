-- Durable creation retries, scoped to the trusted actor. Raw prompts and
-- credentials never belong in these request records.
CREATE TABLE goal_creation_requests (
  actor_user_id uuid NOT NULL REFERENCES users(id),
  request_key uuid NOT NULL,
  account_id uuid NOT NULL REFERENCES bank_accounts(id),
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  goal_id uuid NOT NULL REFERENCES goals(id),
  response jsonb NOT NULL CHECK (jsonb_typeof(response) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (actor_user_id, request_key)
);

-- Original responses let retries return the original IDs and balances even
-- after subsequent movements. Existing historical movements may have no
-- response; replaying such a key fails closed instead of inventing a receipt.
ALTER TABLE goal_movements ADD COLUMN response jsonb
  CHECK (response IS NULL OR jsonb_typeof(response) = 'object');
