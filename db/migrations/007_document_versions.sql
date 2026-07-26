-- File history: an append-only chain of source-file revisions.
--
-- Each row is a snapshot of one source file at a checkpoint (a compilation, a
-- manual snapshot, or a rollback). Identity is anchored to project_files.id, so
-- a file's history survives renames and moves. History is never rewritten: a
-- rollback appends a new revision whose content equals an older one rather than
-- deleting the revisions in between.
--
-- Attribution outlives the account, like the audit trail: author_id is cleared
-- when a user is deleted while author_label keeps a readable identity. A revision
-- of a soft-deleted file is retained; only deleting the whole project cascades
-- its history away.
--
-- Content is stored inline as text. Only text source files are versioned; binary
-- assets and generated output are excluded. Retention and garbage collection are
-- deferred to the hardening phase.

CREATE TABLE document_versions (
  id UUID PRIMARY KEY,
  file_id UUID NOT NULL REFERENCES project_files (id) ON DELETE CASCADE,
  parent_version_id UUID REFERENCES document_versions (id) ON DELETE SET NULL,
  author_id UUID REFERENCES users (id) ON DELETE SET NULL,
  author_label VARCHAR(190) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reason VARCHAR(16) NOT NULL,
  content_hash CHAR(64) NOT NULL,
  content TEXT NOT NULL,
  size INTEGER NOT NULL,
  CONSTRAINT document_versions_reason_check CHECK (reason IN ('manual', 'compile', 'rollback', 'initial')),
  CONSTRAINT document_versions_author_label_check CHECK (author_label <> ''),
  CONSTRAINT document_versions_size_check CHECK (size >= 0)
);

CREATE INDEX idx_document_versions_file ON document_versions (file_id, created_at DESC, id DESC);
