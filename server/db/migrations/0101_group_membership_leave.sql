-- Keep membership keys for historical expenses and settlements.
ALTER TABLE group_members ADD COLUMN left_at timestamptz;
