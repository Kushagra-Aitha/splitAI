CREATE TABLE recurring_split_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id uuid NOT NULL UNIQUE REFERENCES capital_schedules(id),
  payer_id uuid NOT NULL REFERENCES users(id),
  group_id uuid NOT NULL REFERENCES groups(id),
  participant_ids uuid[] NOT NULL CHECK (cardinality(participant_ids) > 0),
  allocation jsonb NOT NULL,
  active_since timestamptz NOT NULL DEFAULT clock_timestamp(),
  paused boolean NOT NULL DEFAULT false
);

CREATE INDEX recurring_split_rules_payer_idx ON recurring_split_rules(payer_id, group_id);

CREATE TABLE recurring_split_expenses (
  operation_id uuid PRIMARY KEY REFERENCES capital_operations(id),
  expense_id uuid NOT NULL UNIQUE REFERENCES expenses(id)
);
