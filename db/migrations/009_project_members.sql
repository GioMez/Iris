-- Project sharing: membership is the single authority for who may access a
-- project and with which role. Roles are per project (owner/editor/viewer) and
-- distinct from the server role; a server admin gets no project access from here.
--
-- Multiple owners are allowed. The application enforces that at least one owner
-- always remains; the schema keeps the membership rows.
--
-- projects.user_id was the single-owner column. It is preserved as created_by —
-- historical provenance only — and is no longer a source of truth for access. A
-- deleted user no longer takes their projects down with them: created_by is set
-- to NULL and the project lives on through its remaining memberships.

CREATE TABLE project_members (
  project_id UUID NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role VARCHAR(16) NOT NULL,
  invited_by UUID REFERENCES users (id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (project_id, user_id),
  CONSTRAINT project_members_role_check CHECK (role IN ('owner', 'editor', 'viewer'))
);

CREATE INDEX idx_project_members_user ON project_members (user_id, created_at DESC);

-- Every existing project's single owner becomes its first membership.
INSERT INTO project_members (project_id, user_id, role, invited_by)
SELECT id, user_id, 'owner', user_id FROM projects;

-- Ownership now lives in project_members; the column becomes historical only.
ALTER TABLE projects DROP CONSTRAINT projects_user_id_fkey;
ALTER TABLE projects RENAME COLUMN user_id TO created_by;
ALTER TABLE projects ALTER COLUMN created_by DROP NOT NULL;
ALTER TABLE projects ADD CONSTRAINT projects_created_by_fkey
  FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL;

-- The old per-owner index indexed the renamed column; membership has its own.
DROP INDEX IF EXISTS idx_projects_user_updated;
CREATE INDEX idx_projects_created_by ON projects (created_by);
