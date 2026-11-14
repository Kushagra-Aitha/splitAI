-- 0200_bank_transactions_source.sql · B2 (Member B)
-- Labeled demo history next to real Nessie activity, plus the two fields the
-- Profile breakdown needs.
--   source          'nessie' = synced from the sandbox; 'demo' = seeded Nov 1–13
--                   history (Nessie cannot backdate transactions)
--   category        spending category (Nessie merchant category, or demo label)
--   payment_method  how it was paid, when known (Card, Bank transfer, ...)

ALTER TABLE bank_transactions
  ADD COLUMN source text NOT NULL DEFAULT 'nessie' CHECK (source IN ('nessie', 'demo')),
  ADD COLUMN category text,
  ADD COLUMN payment_method text;

ALTER TABLE bank_transactions
  ADD CONSTRAINT bank_transactions_status_check
    CHECK (status IN ('pending', 'completed', 'declined', 'cancelled'));

ALTER TABLE bank_import_keys
  ADD COLUMN source text NOT NULL DEFAULT 'nessie' CHECK (source IN ('nessie', 'demo'));
