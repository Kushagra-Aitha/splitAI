-- C2: bind a parsed expense and its eventual draft to the creating actor.
-- Store a message fingerprint, not the raw prompt or conversation history.
CREATE TABLE assistant_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id uuid NOT NULL REFERENCES users(id),
  request_key uuid NOT NULL,
  message_hash text NOT NULL CHECK (message_hash ~ '^[a-f0-9]{64}$'),
  extraction jsonb NOT NULL CHECK (jsonb_typeof(extraction) = 'object'),
  draft_id uuid REFERENCES expenses(id),
  selection_hash text CHECK (selection_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '15 minutes',
  UNIQUE(actor_user_id, request_key),
  CHECK ((draft_id IS NULL) = (selection_hash IS NULL))
);
CREATE INDEX assistant_proposals_expiry_idx ON assistant_proposals(expires_at);
