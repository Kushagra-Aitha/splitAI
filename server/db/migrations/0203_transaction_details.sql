-- B15 · Your category for a bank transaction. The bank's own category stays
-- in `category` (sync may refresh it); Split uses the override when set.
ALTER TABLE bank_transactions
  ADD COLUMN category_override text
    CHECK (category_override IS NULL OR char_length(category_override) BETWEEN 1 AND 40),
  ADD COLUMN category_overridden_at timestamptz;
