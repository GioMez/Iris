-- Retention thresholds, and the index the sweep needs to apply them cheaply.
--
-- The four columns live on the project rather than in the on-disk manifest, so
-- the garbage collector can decide what to prune across every project with set
-- based SQL instead of opening one JSON file per project. It is the same
-- filesystem/database split the rest of the schema follows: bytes on disk,
-- decisions in PostgreSQL.
--
-- Every column is nullable, and null is not "unset" but a value with a meaning:
-- *follow the instance default*. A project that never expresses an opinion keeps
-- tracking the operator's default as it changes, which is what makes raising or
-- lowering a fleet-wide threshold a single environment change rather than a
-- migration over every row. The application clamps whatever is stored here
-- against the operator's ceiling on every read, so a column loosened while a
-- lower ceiling is in force still yields a permitted value.
--
-- The CHECK constraints are floors and absolute ceilings, not the operator's
-- ceiling: they exist so a value written outside the application — by hand, or
-- by a future admin path — still cannot express "keep nothing" or a retention
-- window long enough to be indistinguishable from none. The narrower, operator
-- controlled range is enforced above this layer, because it has to be able to
-- change without a migration.

ALTER TABLE projects
  ADD COLUMN build_keep INTEGER,
  ADD COLUMN build_days INTEGER,
  ADD COLUMN version_keep INTEGER,
  ADD COLUMN version_days INTEGER,
  ADD CONSTRAINT projects_build_keep_check CHECK (build_keep IS NULL OR (build_keep >= 3 AND build_keep <= 200)),
  ADD CONSTRAINT projects_build_days_check CHECK (build_days IS NULL OR (build_days >= 1 AND build_days <= 365)),
  ADD CONSTRAINT projects_version_keep_check CHECK (version_keep IS NULL OR (version_keep >= 10 AND version_keep <= 1000)),
  ADD CONSTRAINT projects_version_days_check CHECK (version_days IS NULL OR (version_days >= 7 AND version_days <= 1095));

-- The version sweep ranks a file's revisions newest-first and deletes from the
-- tail. Without this index that ranking is a sort of the whole partition on
-- every pass; with it the planner walks the existing order and stops early.
-- idx_document_versions_file already orders by (file_id, created_at DESC, id
-- DESC), which is exactly the window's PARTITION BY/ORDER BY, so no second index
-- is needed for revisions.
--
-- Builds are ranked per project, which idx_build_outputs_project already
-- covers. What is missing is the reverse lookup the sweep needs first: the
-- oldest candidates across every project, used to skip projects with nothing to
-- do without ranking them.
CREATE INDEX idx_build_outputs_prunable ON build_outputs (created_at)
  WHERE status <> 'running';

-- A build left 'running' by a process that died has no completion timestamp and
-- no output, and nothing will ever finish it. Startup reconciliation closes
-- these, and this partial index makes finding them free regardless of how much
-- build history the instance has accumulated.
CREATE INDEX idx_build_outputs_running ON build_outputs (created_at) WHERE status = 'running';
