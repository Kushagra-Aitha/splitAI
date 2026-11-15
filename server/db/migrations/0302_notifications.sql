CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('expense_added', 'settlement_sent', 'settlement_posted',
    'settlement_failed', 'guard_blocked', 'comment_added')),
  source_id uuid NOT NULL,
  group_id uuid REFERENCES groups(id) ON DELETE CASCADE,
  expense_id uuid REFERENCES expenses(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  read_at timestamptz,
  UNIQUE (recipient_user_id, kind, source_id),
  CHECK ((kind = 'guard_blocked' AND group_id IS NULL AND expense_id IS NULL)
    OR (kind <> 'guard_blocked' AND group_id IS NOT NULL)),
  CHECK (kind <> 'expense_added' OR (expense_id IS NOT NULL AND expense_id = source_id)),
  CHECK (kind NOT IN ('settlement_sent', 'settlement_posted', 'settlement_failed') OR expense_id IS NULL)
);
CREATE INDEX notifications_recipient_time_idx ON notifications(recipient_user_id, created_at DESC, id DESC);
CREATE INDEX notifications_unread_idx ON notifications(recipient_user_id, group_id) WHERE read_at IS NULL;
