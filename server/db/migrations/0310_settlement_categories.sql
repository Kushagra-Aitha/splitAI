-- B17 · What a settlement pays for. When a settlement is confirmed it is
-- allocated to the categories of the expenses it pays off (oldest first), so
-- the payer's transfer counts as spending in those categories and the payee's
-- incoming money reduces their spending there.
CREATE TABLE settlement_categories (
  settlement_id uuid   NOT NULL REFERENCES settlements (id) ON DELETE CASCADE,
  category      text   NOT NULL CHECK (char_length(category) BETWEEN 1 AND 40),
  cents         bigint NOT NULL CHECK (cents > 0),
  PRIMARY KEY (settlement_id, category)
);
