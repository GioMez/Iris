-- Server-level account administration.
--
-- Two authorization levels are kept distinct: the server role here
-- (admin/regular) governs account management and the admin console, while a
-- project role (owner/editor/viewer) will govern project contents in a later
-- phase. A server admin is not automatically granted access to any project.
--
-- Accounts are deactivated, never deleted, in the MVP: a disabled account loses
-- access immediately while its history, attributions and audit are preserved.
--
-- Sessions are stateless signed tokens, so immediate revocation is expressed
-- through session_epoch: a token is rejected once its issue time predates the
-- account's epoch. Disabling an account or resetting its password advances the
-- epoch, cutting existing sessions on their next request.

ALTER TABLE users RENAME COLUMN role TO system_role;
ALTER TABLE users ALTER COLUMN system_role SET DEFAULT 'regular';
UPDATE users SET system_role = 'regular' WHERE system_role = 'user';
ALTER TABLE users DROP CONSTRAINT users_role_check;
ALTER TABLE users ADD CONSTRAINT users_system_role_check CHECK (system_role IN ('admin', 'regular'));

ALTER TABLE users
  ADD COLUMN status VARCHAR(16) NOT NULL DEFAULT 'active',
  ADD COLUMN auth_source VARCHAR(16) NOT NULL DEFAULT 'local',
  ADD COLUMN oidc_issuer TEXT,
  ADD COLUMN oidc_subject TEXT,
  ADD COLUMN disabled_at TIMESTAMPTZ,
  ADD COLUMN last_login_at TIMESTAMPTZ,
  ADD COLUMN session_epoch TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD CONSTRAINT users_status_check CHECK (status IN ('active', 'disabled')),
  ADD CONSTRAINT users_auth_source_check CHECK (auth_source IN ('local', 'oidc'));

-- An account created without a local password hash authenticates through OIDC.
UPDATE users SET auth_source = 'oidc' WHERE password_hash IS NULL;

-- For OIDC accounts the durable identity is the issuer + subject pair, not the
-- email, which may change. Unique only when both are present.
CREATE UNIQUE INDEX uq_users_oidc_identity
  ON users (oidc_issuer, oidc_subject)
  WHERE oidc_issuer IS NOT NULL AND oidc_subject IS NOT NULL;
