ALTER TABLE projects
  ADD COLUMN lua_sources_changed_at TIMESTAMPTZ,
  ADD COLUMN lua_sources_hash CHAR(64) CHECK (lua_sources_hash ~ '^[a-f0-9]{64}$'),
  ADD COLUMN lua_sources_pending BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN lua_sources_approval_session UUID,
  ADD COLUMN lua_sources_author_id UUID REFERENCES users(id) ON DELETE SET NULL;

CREATE TABLE pipeline_auto_approvals (
  project_id UUID NOT NULL,
  user_id UUID NOT NULL,
  PRIMARY KEY (project_id, user_id),
  FOREIGN KEY (project_id, user_id) REFERENCES project_members(project_id, user_id) ON DELETE CASCADE
);
