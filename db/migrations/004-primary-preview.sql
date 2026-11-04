-- initializeSchema owns the advisory lock and transaction. Older runs did not
-- retain their plan's preview reference; leave that unknown rather than infer it.
ALTER TABLE build_outputs
  ADD COLUMN primary_preview JSONB,
  ADD CONSTRAINT build_outputs_primary_preview_check CHECK (
    primary_preview IS NULL OR (kind = 'pipeline' AND plan_hash IS NOT NULL
      AND jsonb_typeof(primary_preview) = 'object'
      AND primary_preview - 'step' - 'port' = '{}'::jsonb
      AND jsonb_typeof(primary_preview->'step') = 'string'
      AND jsonb_typeof(primary_preview->'port') = 'string'
      AND primary_preview->>'step' ~ '^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$'
      AND primary_preview->>'port' ~ '^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$') IS TRUE
  );

CREATE INDEX idx_build_outputs_request ON build_outputs (project_id, request_order DESC);
CREATE INDEX idx_build_outputs_target_request ON build_outputs (project_id, kind, target, request_order DESC);
