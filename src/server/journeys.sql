CREATE TABLE IF NOT EXISTS sessions (
  id uuid PRIMARY KEY, expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
CREATE TABLE IF NOT EXISTS journeys (
  id uuid PRIMARY KEY, owner uuid NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,
  settings jsonb NOT NULL, settings_revision integer NOT NULL DEFAULT 1,
  revision integer NOT NULL DEFAULT 1, advice jsonb, evidence_hash text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS journey_commands (
  owner uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, key text NOT NULL,
  request_hash text NOT NULL, response jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(owner,key)
);
CREATE TABLE IF NOT EXISTS decisions (
  id uuid PRIMARY KEY, journey_id uuid NOT NULL REFERENCES journeys(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(), advice jsonb NOT NULL, input jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS decisions_journey_time ON decisions(journey_id,created_at DESC);
CREATE TABLE IF NOT EXISTS outbox (
  id uuid PRIMARY KEY, journey_id uuid NOT NULL REFERENCES journeys(id) ON DELETE CASCADE,
  revision integer NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), published_at timestamptz
);
CREATE INDEX IF NOT EXISTS outbox_pending ON outbox(created_at) WHERE published_at IS NULL;
