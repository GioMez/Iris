-- Marks an account converted from local to SSO through the admin-opened linking
-- window (see 010), as opposed to one auto-registered as SSO from the start.
-- A local login attempt on such an account can then explain that it can no
-- longer use local credentials, and an admin can undo the conversion (unlink)
-- to hand back local access with a fresh temporary password.
--
-- This ships as its own migration because 010 had already been applied when the
-- column was introduced, and applied migrations are immutable.

ALTER TABLE users
  ADD COLUMN oidc_linked_at TIMESTAMPTZ;
