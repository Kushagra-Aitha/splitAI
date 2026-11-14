-- Keep normalized matching criteria, not the raw user prompt or copied bank data.
ALTER TABLE assistant_proposals ADD COLUMN bank_query jsonb
  CHECK (bank_query IS NULL OR jsonb_typeof(bank_query) = 'object');
