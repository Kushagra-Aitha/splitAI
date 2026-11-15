-- C17: Capital Two cards have one durable statement due day shared by every
-- read model. The sandbox product uses the 25th; month-end clamping happens
-- when the next concrete due date is derived.
ALTER TABLE bank_accounts ADD COLUMN statement_due_day smallint
  CHECK (statement_due_day BETWEEN 1 AND 31);

UPDATE bank_accounts SET statement_due_day = 25
WHERE kind = 'credit_card' AND statement_due_day IS NULL;
