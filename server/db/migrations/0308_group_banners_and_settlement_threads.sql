ALTER TABLE groups DROP CONSTRAINT groups_kind_check;
ALTER TABLE groups ADD CONSTRAINT groups_kind_check
  CHECK (kind IN ('trip', 'roommates', 'friends', 'couple', 'event', 'work'));
ALTER TABLE groups ADD COLUMN banner text
  CHECK (banner IN ('trip', 'roommates', 'friends', 'couple', 'event', 'work'));

ALTER TABLE settlements ADD CONSTRAINT settlements_id_group_uq UNIQUE (id, group_id);
ALTER TABLE group_comments ADD COLUMN settlement_id uuid;
ALTER TABLE group_comments ADD CONSTRAINT comments_settlement_group_fk
  FOREIGN KEY (settlement_id, group_id) REFERENCES settlements(id, group_id) ON DELETE CASCADE;
ALTER TABLE group_comments ADD CONSTRAINT comments_one_thread
  CHECK (expense_id IS NULL OR settlement_id IS NULL);
CREATE INDEX group_comments_settlement_time_idx ON group_comments(settlement_id, created_at DESC, id DESC)
  WHERE settlement_id IS NOT NULL;
