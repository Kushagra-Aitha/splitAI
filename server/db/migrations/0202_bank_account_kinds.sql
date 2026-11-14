-- B12 · A user can have a Capital Two checking account and a credit card.
-- `kind` says which; `linked_at` records the moment the user agreed to share
-- that account with Split (the Connect screen). Only linked accounts sync or
-- count toward Overview, spendable funds and settlements.
ALTER TABLE bank_accounts DROP CONSTRAINT IF EXISTS bank_accounts_user_id_key;

ALTER TABLE bank_accounts
  ADD COLUMN kind text NOT NULL DEFAULT 'checking' CHECK (kind IN ('checking', 'credit_card')),
  ADD COLUMN credit_limit_cents bigint CHECK (credit_limit_cents IS NULL OR credit_limit_cents >= 0),
  ADD COLUMN linked_at timestamptz;

UPDATE bank_accounts SET kind = 'credit_card' WHERE account_type = 'Credit Card';
-- Accounts already mapped before B12 were shared under the old flow.
UPDATE bank_accounts SET linked_at = coalesce(balance_as_of, updated_at, now())
 WHERE provider_account_id IS NOT NULL;

CREATE UNIQUE INDEX bank_accounts_user_kind_key ON bank_accounts (user_id, kind);
CREATE INDEX bank_accounts_linked_user_idx ON bank_accounts (user_id) WHERE linked_at IS NOT NULL;
