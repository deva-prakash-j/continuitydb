-- ContinuityDB distributed metadata/reference schema.
-- PostgreSQL 17 + pgvector 0.8+. Apply through a migration runner as one owner role.

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS tenants (
  id text PRIMARY KEY,
  display_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'deleted'))
);

CREATE TABLE IF NOT EXISTS principals (
  tenant_id text NOT NULL REFERENCES tenants(id),
  id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('user', 'agent', 'service')),
  scopes text[] NOT NULL DEFAULT '{}',
  allowed_projects text[] NOT NULL DEFAULT '{}',
  allowed_sensitivities text[] NOT NULL DEFAULT ARRAY['public','private'],
  created_at timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz,
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS memory_records (
  tenant_id text NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  owner_id text NOT NULL,
  agent_id text,
  namespace_id text NOT NULL,
  project_id text,
  type text NOT NULL,
  title text NOT NULL,
  body_inline text,
  body_storage_uri text,
  body_sha256 bytea NOT NULL,
  status text NOT NULL CHECK (status IN ('proposed','active','superseded','tombstoned','quarantined')),
  importance real NOT NULL CHECK (importance BETWEEN 0 AND 1),
  confidence real NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  sensitivity text NOT NULL CHECK (sensitivity IN ('public','private','sensitive','restricted')),
  source_type text NOT NULL,
  source_uri text,
  repo_path text,
  symbol text,
  git_commit text,
  branch text,
  tags text[] NOT NULL DEFAULT '{}',
  metadata jsonb NOT NULL DEFAULT '{}',
  valid_from timestamptz,
  valid_to timestamptz,
  observed_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  stale boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  supersedes_id uuid,
  idempotency_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  search_document tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(symbol, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(repo_path, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(body_inline, '')), 'C')
  ) STORED,
  PRIMARY KEY (tenant_id, id),
  CHECK (body_inline IS NOT NULL OR body_storage_uri IS NOT NULL),
  CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_from < valid_to),
  FOREIGN KEY (tenant_id, owner_id) REFERENCES principals(tenant_id, id)
) PARTITION BY HASH (tenant_id);

DO $$
BEGIN
  FOR partition_number IN 0..63 LOOP
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS memory_records_p%s PARTITION OF memory_records FOR VALUES WITH (MODULUS 64, REMAINDER %s)',
      partition_number,
      partition_number
    );
  END LOOP;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS memory_records_idempotency
  ON memory_records(tenant_id, owner_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS memory_records_scope_active
  ON memory_records(tenant_id, namespace_id, updated_at DESC)
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS memory_records_project_active
  ON memory_records(tenant_id, project_id, branch, updated_at DESC)
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS memory_records_fts
  ON memory_records USING gin(search_document);
CREATE INDEX IF NOT EXISTS memory_records_expiry
  ON memory_records USING brin(expires_at) WITH (pages_per_range = 64);

CREATE TABLE IF NOT EXISTS memory_embeddings (
  tenant_id text NOT NULL,
  memory_id uuid NOT NULL,
  model_id text NOT NULL,
  model_version text NOT NULL,
  embedding vector(1024) NOT NULL,
  content_sha256 bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, memory_id, model_id, model_version),
  FOREIGN KEY (tenant_id, memory_id) REFERENCES memory_records(tenant_id, id) ON DELETE CASCADE
) PARTITION BY HASH (tenant_id);

DO $$
BEGIN
  FOR partition_number IN 0..63 LOOP
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS memory_embeddings_p%s PARTITION OF memory_embeddings FOR VALUES WITH (MODULUS 64, REMAINDER %s)',
      partition_number,
      partition_number
    );
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS memory_embeddings_p%s_hnsw ON memory_embeddings_p%s USING hnsw (embedding vector_cosine_ops) WITH (m = 24, ef_construction = 128)',
      partition_number,
      partition_number
    );
  END LOOP;
END $$;

CREATE TABLE IF NOT EXISTS graph_edges (
  tenant_id text NOT NULL,
  source_kind text NOT NULL,
  source_id text NOT NULL,
  target_kind text NOT NULL,
  target_id text NOT NULL,
  relation text NOT NULL,
  weight real NOT NULL CHECK (weight BETWEEN 0 AND 1),
  provenance jsonb NOT NULL,
  valid_from timestamptz,
  valid_to timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, source_kind, source_id, target_kind, target_id, relation),
  CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_from < valid_to)
) PARTITION BY HASH (tenant_id);

DO $$
BEGIN
  FOR partition_number IN 0..63 LOOP
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS graph_edges_p%s PARTITION OF graph_edges FOR VALUES WITH (MODULUS 64, REMAINDER %s)',
      partition_number,
      partition_number
    );
  END LOOP;
END $$;

CREATE INDEX IF NOT EXISTS graph_edges_forward
  ON graph_edges(tenant_id, source_kind, source_id, relation, valid_to);
CREATE INDEX IF NOT EXISTS graph_edges_reverse
  ON graph_edges(tenant_id, target_kind, target_id, relation, valid_to);

CREATE TABLE IF NOT EXISTS ingest_jobs (
  tenant_id text NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  job_type text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','completed','failed','dead-letter')),
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_owner text,
  lease_until timestamptz,
  idempotency_key text NOT NULL,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, idempotency_key)
) PARTITION BY HASH (tenant_id);

DO $$
BEGIN
  FOR partition_number IN 0..63 LOOP
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS ingest_jobs_p%s PARTITION OF ingest_jobs FOR VALUES WITH (MODULUS 64, REMAINDER %s)',
      partition_number,
      partition_number
    );
  END LOOP;
END $$;

CREATE INDEX IF NOT EXISTS ingest_jobs_claim
  ON ingest_jobs(status, available_at, lease_until)
  WHERE status IN ('queued','running');

CREATE TABLE IF NOT EXISTS outbox_events (
  tenant_id text NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  event_type text NOT NULL,
  aggregate_id text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  PRIMARY KEY (tenant_id, id)
) PARTITION BY HASH (tenant_id);

DO $$
BEGIN
  FOR partition_number IN 0..63 LOOP
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS outbox_events_p%s PARTITION OF outbox_events FOR VALUES WITH (MODULUS 64, REMAINDER %s)',
      partition_number,
      partition_number
    );
  END LOOP;
END $$;

CREATE INDEX IF NOT EXISTS outbox_events_pending
  ON outbox_events(created_at) WHERE published_at IS NULL;

CREATE TABLE IF NOT EXISTS audit_events (
  tenant_id text NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  principal_id text NOT NULL,
  operation text NOT NULL,
  target_id text,
  result text NOT NULL,
  request_id text,
  previous_hash bytea,
  event_hash bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
) PARTITION BY HASH (tenant_id);

DO $$
BEGIN
  FOR partition_number IN 0..63 LOOP
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS audit_events_p%s PARTITION OF audit_events FOR VALUES WITH (MODULUS 64, REMAINDER %s)',
      partition_number,
      partition_number
    );
  END LOOP;
END $$;

ALTER TABLE principals ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_embeddings ENABLE ROW LEVEL SECURITY;
ALTER TABLE graph_edges ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingest_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_principals ON principals
  USING (tenant_id = current_setting('continuity.tenant_id', true));
CREATE POLICY tenant_isolation_memories ON memory_records
  USING (tenant_id = current_setting('continuity.tenant_id', true));
CREATE POLICY tenant_isolation_embeddings ON memory_embeddings
  USING (tenant_id = current_setting('continuity.tenant_id', true));
CREATE POLICY tenant_isolation_graph ON graph_edges
  USING (tenant_id = current_setting('continuity.tenant_id', true));
CREATE POLICY tenant_isolation_jobs ON ingest_jobs
  USING (tenant_id = current_setting('continuity.tenant_id', true));
CREATE POLICY tenant_isolation_outbox ON outbox_events
  USING (tenant_id = current_setting('continuity.tenant_id', true));
CREATE POLICY tenant_isolation_audit ON audit_events
  USING (tenant_id = current_setting('continuity.tenant_id', true));

COMMIT;
