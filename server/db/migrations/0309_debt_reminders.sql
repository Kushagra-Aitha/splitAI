CREATE TABLE debt_reminders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_user_id uuid NOT NULL REFERENCES users(id),
  recipient_user_id uuid NOT NULL REFERENCES users(id),
  group_id uuid NOT NULL REFERENCES groups(id),
  expense_id uuid REFERENCES expenses(id),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  request_key uuid NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent')),
  expires_at timestamptz NOT NULL DEFAULT (clock_timestamp() + interval '10 minutes'),
  sent_on date,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (sender_user_id <> recipient_user_id),
  CHECK ((status = 'sent') = (sent_on IS NOT NULL)),
  UNIQUE (sender_user_id, request_key)
);
CREATE UNIQUE INDEX debt_reminders_daily_idx ON debt_reminders(sender_user_id, recipient_user_id, group_id, sent_on)
  WHERE status = 'sent';
ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check CHECK (kind IN (
  'expense_added', 'settlement_sent', 'settlement_posted', 'settlement_failed',
  'guard_blocked', 'comment_added', 'guard_flagged', 'debt_reminder'
));
CREATE INDEX goal_movements_history_idx ON goal_movements(goal_id, created_at DESC, id DESC);
