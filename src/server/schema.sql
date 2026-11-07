CREATE TABLE IF NOT EXISTS collector_generations (
  source text PRIMARY KEY CHECK (source IN ('predictions','alerts')),
  generation integer NOT NULL DEFAULT 0,
  acquired_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS source_health (
  source text PRIMARY KEY CHECK (source IN ('predictions','alerts')),
  generation integer NOT NULL, revision bigint NOT NULL, health jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS source_gaps (
  source text PRIMARY KEY, reason text NOT NULL, requested_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS current_predictions (
  id text PRIMARY KEY, trip_id text NOT NULL, route_id text NOT NULL,
  stop_id text NOT NULL, stop_sequence integer NOT NULL, direction integer,
  arrival_time timestamptz, departure_time timestamptz, schedule_relationship text,
  payload jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS predictions_trip_stop ON current_predictions (trip_id, stop_id);
CREATE INDEX IF NOT EXISTS predictions_route_stop ON current_predictions (route_id, stop_id);
CREATE TABLE IF NOT EXISTS current_alerts (id text PRIMARY KEY, effect text NOT NULL, payload jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS processed_messages (
  message_id text PRIMARY KEY, fingerprint text NOT NULL, processed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS processed_messages_age ON processed_messages (processed_at);
CREATE TABLE IF NOT EXISTS projection_checkpoints (
  topic text NOT NULL, partition_id integer NOT NULL, next_offset numeric(20,0) NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(topic,partition_id)
);
CREATE TABLE IF NOT EXISTS snapshot_staging (
  snapshot_id text PRIMARY KEY, source text NOT NULL, metadata jsonb NOT NULL,
  manifest jsonb, first_offset numeric(20,0) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS snapshot_chunks (
  snapshot_id text NOT NULL REFERENCES snapshot_staging(snapshot_id) ON DELETE CASCADE,
  chunk_index integer NOT NULL, payload jsonb NOT NULL,
  PRIMARY KEY(snapshot_id,chunk_index)
);
CREATE TABLE IF NOT EXISTS snapshot_catalog (
  snapshot_id text PRIMARY KEY, source text NOT NULL, topic text NOT NULL,
  partition_id integer NOT NULL, first_offset numeric(20,0) NOT NULL,
  end_offset numeric(20,0) NOT NULL, observed_at timestamptz NOT NULL,
  generation integer NOT NULL, revision bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS snapshot_catalog_source_time ON snapshot_catalog(source,observed_at);
CREATE TABLE IF NOT EXISTS quarantine (
  topic text NOT NULL, partition_id integer NOT NULL, offset_id numeric(20,0) NOT NULL,
  reason text NOT NULL, payload_prefix text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(topic,partition_id,offset_id)
);
