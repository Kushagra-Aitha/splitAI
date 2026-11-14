ALTER TABLE expenses ADD CONSTRAINT expenses_bank_reference_complete
  CHECK ((bank_account_id IS NULL) = (bank_provider_key IS NULL));

CREATE UNIQUE INDEX expenses_confirmed_bank_purchase_uq
  ON expenses (bank_account_id, bank_provider_key)
  WHERE status = 'confirmed' AND bank_account_id IS NOT NULL;
