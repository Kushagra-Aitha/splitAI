ALTER TABLE expenses ADD CONSTRAINT expenses_id_group_uq UNIQUE (id, group_id);

CREATE TABLE group_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  expense_id uuid,
  author_user_id uuid NOT NULL,
  text text NOT NULL CHECK (char_length(text) BETWEEN 1 AND 500 AND btrim(text) <> ''),
  request_key uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (group_id, author_user_id) REFERENCES group_members(group_id, user_id),
  FOREIGN KEY (expense_id, group_id) REFERENCES expenses(id, group_id) ON DELETE CASCADE,
  UNIQUE (author_user_id, request_key)
);
CREATE INDEX group_comments_time_idx ON group_comments(group_id, created_at DESC, id DESC);
CREATE INDEX group_comments_expense_time_idx ON group_comments(expense_id, created_at DESC, id DESC)
  WHERE expense_id IS NOT NULL;
CREATE INDEX group_comments_author_time_idx ON group_comments(group_id, author_user_id, created_at DESC);
CREATE INDEX expenses_activity_time_idx ON expenses(group_id, confirmed_at DESC, id DESC) WHERE status = 'confirmed';
CREATE INDEX settlements_activity_time_idx ON settlements(group_id, (coalesce(resolved_at, claimed_at, created_at)) DESC, id DESC)
  WHERE status IN ('pending', 'posted', 'failed');
