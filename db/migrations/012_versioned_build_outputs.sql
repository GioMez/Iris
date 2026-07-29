-- Versioned compilation outputs. One build_outputs row represents one compiler
-- run; build_artifacts contains the one-or-many previewable files it produced.
-- The directory is published atomically at output/<build-id> before a successful
-- row is completed, while failed builds retain diagnostics but no partial output.
--
-- source_revision_id normally identifies the checkpoint of the main source used
-- by the build. It is nullable because source history deliberately skips text
-- above its size cap; source_content_hash remains available in that case.

-- Composite references below make the source provenance project-safe. These
-- redundant unique keys let PostgreSQL prove that both the source file and its
-- optional revision belong to the build's project.
ALTER TABLE project_files ADD CONSTRAINT project_files_id_project_unique UNIQUE (id, project_id);
ALTER TABLE document_versions ADD CONSTRAINT document_versions_id_file_unique UNIQUE (id, file_id);

CREATE TABLE build_outputs (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  source_file_id UUID NOT NULL,
  source_revision_id UUID,
  source_content_hash CHAR(64) NOT NULL,
  created_by UUID REFERENCES users (id) ON DELETE SET NULL,
  created_by_label VARCHAR(190) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMPTZ,
  status VARCHAR(16) NOT NULL DEFAULT 'running',
  project_type VARCHAR(16) NOT NULL,
  compiler VARCHAR(32) NOT NULL,
  format VARCHAR(16) NOT NULL,
  main_path TEXT NOT NULL,
  display_name VARCHAR(255) NOT NULL,
  storage_path TEXT,
  size BIGINT NOT NULL DEFAULT 0,
  content_hash CHAR(64),
  artifact_count INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER,
  exit_code INTEGER,
  signal VARCHAR(32),
  timed_out BOOLEAN NOT NULL DEFAULT FALSE,
  log TEXT NOT NULL DEFAULT '',
  warnings JSONB NOT NULL DEFAULT '[]'::jsonb,
  errors JSONB NOT NULL DEFAULT '[]'::jsonb,
  CONSTRAINT build_outputs_status_check CHECK (status IN ('running', 'succeeded', 'failed')),
  CONSTRAINT build_outputs_project_type_check CHECK (project_type IN ('latex', 'lilypond')),
  CONSTRAINT build_outputs_format_check CHECK (format IN ('pdf', 'png', 'svg', 'ps', 'eps')),
  CONSTRAINT build_outputs_creator_label_check CHECK (created_by_label <> ''),
  CONSTRAINT build_outputs_main_path_check CHECK (
    main_path <> '' AND main_path !~ '(^/|(^|/)\.\.(/|$)|\\)'
  ),
  CONSTRAINT build_outputs_display_name_check CHECK (display_name <> ''),
  CONSTRAINT build_outputs_size_check CHECK (size >= 0),
  CONSTRAINT build_outputs_artifact_count_check CHECK (artifact_count >= 0),
  CONSTRAINT build_outputs_duration_check CHECK (duration_ms IS NULL OR duration_ms >= 0),
  CONSTRAINT build_outputs_json_check CHECK (
    jsonb_typeof(warnings) = 'array' AND jsonb_typeof(errors) = 'array'
  ),
  CONSTRAINT build_outputs_source_file_fkey FOREIGN KEY (source_file_id, project_id)
    REFERENCES project_files (id, project_id) ON DELETE CASCADE,
  CONSTRAINT build_outputs_source_revision_fkey FOREIGN KEY (source_revision_id, source_file_id)
    REFERENCES document_versions (id, file_id) ON DELETE SET NULL (source_revision_id),
  CONSTRAINT build_outputs_lifecycle_check CHECK (
    (status = 'running' AND completed_at IS NULL AND storage_path IS NULL AND artifact_count = 0 AND size = 0 AND content_hash IS NULL)
    OR
    (status = 'succeeded' AND completed_at IS NOT NULL AND storage_path = 'output/' || id::text AND artifact_count > 0 AND content_hash IS NOT NULL)
    OR
    (status = 'failed' AND completed_at IS NOT NULL AND storage_path IS NULL AND artifact_count = 0 AND size = 0 AND content_hash IS NULL)
  )
);

CREATE TABLE build_artifacts (
  id UUID PRIMARY KEY,
  build_id UUID NOT NULL REFERENCES build_outputs (id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  storage_path TEXT NOT NULL,
  mime_type VARCHAR(100) NOT NULL,
  size BIGINT NOT NULL,
  content_hash CHAR(64) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT build_artifacts_name_check CHECK (
    name <> '' AND name NOT IN ('.', '..') AND name !~ '[/\\]'
  ),
  CONSTRAINT build_artifacts_path_check CHECK (
    storage_path <> '' AND storage_path !~ '(^/|(^|/)\.\.(/|$)|\\)'
  ),
  CONSTRAINT build_artifacts_mime_check CHECK (mime_type <> ''),
  CONSTRAINT build_artifacts_size_check CHECK (size >= 0),
  UNIQUE (build_id, name),
  UNIQUE (build_id, storage_path)
);

CREATE INDEX idx_build_outputs_project ON build_outputs (project_id, created_at DESC, id DESC);
CREATE INDEX idx_build_outputs_source_revision ON build_outputs (source_revision_id) WHERE source_revision_id IS NOT NULL;
CREATE INDEX idx_build_outputs_creator ON build_outputs (created_by, created_at DESC) WHERE created_by IS NOT NULL;
CREATE INDEX idx_build_artifacts_build ON build_artifacts (build_id, name);
