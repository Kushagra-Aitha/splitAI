-- C13: bank-authored categories and repeat-safe salary occurrences.
ALTER TABLE capital_operations DROP CONSTRAINT capital_operations_kind_check;
ALTER TABLE capital_operations ADD CONSTRAINT capital_operations_kind_check
  CHECK (kind IN ('purchase', 'withdrawal', 'card_payment', 'deposit'));
ALTER TABLE capital_operations ADD COLUMN category text NOT NULL DEFAULT 'Other'
  CHECK (char_length(category) BETWEEN 1 AND 60);
ALTER TABLE capital_schedules ADD COLUMN kind text NOT NULL DEFAULT 'purchase'
  CHECK (kind IN ('purchase', 'salary'));
ALTER TABLE capital_schedules ADD COLUMN frequency text NOT NULL DEFAULT 'monthly'
  CHECK (frequency IN ('monthly', 'biweekly'));
ALTER TABLE capital_schedules ADD COLUMN first_due_on date;
UPDATE capital_schedules SET first_due_on = next_due_on;
ALTER TABLE capital_schedules ALTER COLUMN first_due_on SET NOT NULL;
ALTER TABLE capital_schedules ADD COLUMN category text NOT NULL DEFAULT 'Other'
  CHECK (char_length(category) BETWEEN 1 AND 60);
ALTER TABLE capital_schedules ADD CONSTRAINT capital_salary_shape CHECK (
  kind <> 'salary' OR category = 'Salary' AND
    ((frequency = 'monthly' AND day_of_month IS NOT NULL) OR
     (frequency = 'biweekly' AND day_of_month IS NULL))
);
CREATE INDEX capital_operations_account_reference_idx ON capital_operations(account_id, provider_reference)
  WHERE provider_reference IS NOT NULL;

-- Preserve existing bank categories when attaching metadata to older operations.
UPDATE capital_operations o SET category = t.category
FROM bank_import_keys k JOIN bank_transactions t
  ON t.account_id = k.account_id AND t.id = k.transaction_id AND t.occurred_at = k.occurred_at
WHERE o.account_id = k.account_id AND o.provider_reference = k.provider_key
  AND char_length(t.category) BETWEEN 1 AND 60;
UPDATE capital_schedules SET category = 'Housing' WHERE kind = 'purchase' AND payee = 'Rent';
