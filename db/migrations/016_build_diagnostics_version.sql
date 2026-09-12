ALTER TABLE build_outputs ADD COLUMN diagnostics_version INTEGER;

-- Current fresh-definition holder; BE16 carries this table into db/schema.sql.
CREATE TABLE project_deletions (
  project_id UUID PRIMARY KEY,
  owner_ids UUID[] NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('prepared', 'cleanup_ready', 'complete')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMPTZ,
  CHECK ((state = 'complete') = (completed_at IS NOT NULL)),
  CHECK (completed_at >= created_at)
);
