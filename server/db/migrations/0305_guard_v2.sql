ALTER TABLE group_comments
  ADD COLUMN guard_flagged boolean NOT NULL DEFAULT false,
  ADD COLUMN guard_score double precision CHECK (guard_score BETWEEN 0 AND 1),
  ADD COLUMN guard_reasons jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(guard_reasons) = 'array' AND jsonb_array_length(guard_reasons) <= 4),
  ADD COLUMN guard_model_version text;

ALTER TABLE guard_events ADD COLUMN comment_id uuid REFERENCES group_comments(id) ON DELETE CASCADE;
CREATE UNIQUE INDEX guard_events_comment_actor_idx ON guard_events(comment_id, actor_user_id) WHERE comment_id IS NOT NULL;

CREATE TABLE guard_settings (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  comment_alerts_enabled boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE guard_feedback (
  event_id uuid PRIMARY KEY REFERENCES guard_events(id) ON DELETE CASCADE,
  actor_user_id uuid NOT NULL REFERENCES users(id),
  label text NOT NULL CHECK (label IN ('ham', 'spam')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check CHECK (kind IN (
  'expense_added', 'settlement_sent', 'settlement_posted', 'settlement_failed', 'guard_blocked', 'comment_added', 'guard_flagged'));
