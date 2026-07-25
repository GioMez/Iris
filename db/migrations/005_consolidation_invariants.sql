-- Final invariants for the PostgreSQL consolidation.
--
-- A project directory is derived exclusively from its immutable id. Relative
-- path validation alone is insufficient because it would still allow a row to
-- name another project's directory.
ALTER TABLE projects
  ADD CONSTRAINT projects_storage_path_canonical CHECK (
    storage_path = 'projects/' || id::text
  );

-- Audit metadata is deliberately small and flat. The application already
-- normalizes it, while these checks keep the same boundary for maintenance SQL
-- and future writers that do not pass through src/audit.js.
ALTER TABLE audit_events
  ADD CONSTRAINT audit_events_metadata_scalars_check CHECK (
    NOT jsonb_path_exists(
      metadata,
      'strict $.* ? (@.type() == "object" || @.type() == "array" || @.type() == "null")'
    )
  ),
  ADD CONSTRAINT audit_events_metadata_size_check CHECK (
    octet_length(metadata::text) <= 8192
  );
