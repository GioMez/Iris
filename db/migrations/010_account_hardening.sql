-- Account hardening: forced first-login password change and admin-gated OIDC
-- account linking.
--
-- password_change_required is raised when an admin creates an account or resets
-- its password: the temporary password is genuinely one-time, and its holder
-- must set a new one before the session can do anything else. It is cleared on a
-- successful self-service password change.
--
-- oidc_link_pending is an admin-opened, single-use window. When an SSO login's
-- durable identity (issuer + subject) is unknown but its email matches an
-- existing account, the identity is bound to that account only while this flag
-- is set; the link then clears the flag and, from that point, the account is
-- SSO-only (its local password hash is dropped). Without an open window the SSO
-- login is refused and the account is left untouched.
--
-- oidc_linked_at marks an account that was converted from local to SSO through
-- that window (as opposed to one auto-registered as SSO from the start). It lets
-- a local login attempt on a converted account explain that it can no longer use
-- local credentials, and an admin can undo the conversion (unlink) to hand back
-- local access with a fresh temporary password.

ALTER TABLE users
  ADD COLUMN password_change_required BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN oidc_link_pending BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN oidc_linked_at TIMESTAMPTZ;
