-- ContinuityDB v0.3: shared owners, policy capture conflicts, and bounded feedback.

BEGIN;

ALTER TABLE principals ADD COLUMN IF NOT EXISTS owner_id text;
UPDATE principals SET owner_id = id WHERE owner_id IS NULL;
ALTER TABLE principals ALTER COLUMN owner_id SET NOT NULL;

ALTER TABLE memory_records ADD COLUMN IF NOT EXISTS subject_key text;

DROP INDEX IF EXISTS memory_records_idempotency;
CREATE UNIQUE INDEX IF NOT EXISTS memory_records_actor_idempotency
  ON memory_records(tenant_id, owner_id, namespace_id, COALESCE(agent_id, ''), idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS memory_records_subject_active
  ON memory_records(tenant_id, owner_id, project_id, subject_key, updated_at DESC)
  WHERE status = 'active' AND subject_key IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS memory_records_owner_identity
  ON memory_records(tenant_id, id, owner_id);

CREATE TABLE IF NOT EXISTS memory_feedback (
  tenant_id text NOT NULL,
  owner_id text NOT NULL,
  memory_id uuid NOT NULL,
  principal_id text NOT NULL,
  agent_id text,
  signal text NOT NULL CHECK (signal IN ('helpful','incorrect','outdated')),
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, memory_id, principal_id),
  FOREIGN KEY (tenant_id, memory_id, owner_id)
    REFERENCES memory_records(tenant_id, id, owner_id) ON DELETE CASCADE
) PARTITION BY HASH (tenant_id);

DO $$
BEGIN
  FOR partition_number IN 0..63 LOOP
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS memory_feedback_p%s PARTITION OF memory_feedback FOR VALUES WITH (MODULUS 64, REMAINDER %s)',
      partition_number,
      partition_number
    );
  END LOOP;
END $$;

CREATE INDEX IF NOT EXISTS memory_feedback_owner
  ON memory_feedback(tenant_id, owner_id, memory_id, signal);

ALTER TABLE memory_feedback ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_principals ON principals;
CREATE POLICY owner_isolation_principals ON principals
  USING (
    tenant_id = current_setting('continuity.tenant_id', true)
    AND owner_id = current_setting('continuity.owner_id', true)
  )
  WITH CHECK (
    tenant_id = current_setting('continuity.tenant_id', true)
    AND owner_id = current_setting('continuity.owner_id', true)
  );

DROP POLICY IF EXISTS tenant_isolation_memories ON memory_records;
CREATE POLICY owner_isolation_memories ON memory_records
  USING (
    tenant_id = current_setting('continuity.tenant_id', true)
    AND owner_id = current_setting('continuity.owner_id', true)
  )
  WITH CHECK (
    tenant_id = current_setting('continuity.tenant_id', true)
    AND owner_id = current_setting('continuity.owner_id', true)
  );

CREATE POLICY owner_isolation_feedback ON memory_feedback
  USING (
    tenant_id = current_setting('continuity.tenant_id', true)
    AND owner_id = current_setting('continuity.owner_id', true)
  )
  WITH CHECK (
    tenant_id = current_setting('continuity.tenant_id', true)
    AND owner_id = current_setting('continuity.owner_id', true)
  );

COMMIT;
