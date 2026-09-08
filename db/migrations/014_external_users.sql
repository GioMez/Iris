-- External users, and a holding state for accounts the IdP provisioned on its own.
--
-- 'external' is a third server role: an account that works on projects it was
-- invited to and nothing else. It never originates a project (no create, no
-- import) and never holds the project role that answers for one, so ownership —
-- and with it the responsibility for a project's existence — stays with the
-- organisation even when the work does not. Project roles are unchanged; because
-- no external can be an owner, every owner is internal by construction and the
-- existing "at least one owner" invariant keeps its meaning.
--
-- 'pending' is an account that has never had access: it is created by SSO
-- auto-provisioning and waits for an administrator to approve it. It is distinct
-- from 'disabled' because the two mean opposite things to whoever reads the list
-- — a stranger who knocked versus a colleague whose access was revoked — and
-- conflating them turns the approval queue into the same list as the graveyard.
-- Every access check in the application admits 'active' and denies everything
-- else, so the new state is refused everywhere from the moment it exists.
-- disabled_at stays null for a pending account: it was never disabled, and the
-- date that describes it is created_at.

ALTER TABLE users DROP CONSTRAINT users_system_role_check;
ALTER TABLE users ADD CONSTRAINT users_system_role_check
  CHECK (system_role IN ('admin', 'regular', 'external'));

ALTER TABLE users DROP CONSTRAINT users_status_check;
ALTER TABLE users ADD CONSTRAINT users_status_check
  CHECK (status IN ('active', 'disabled', 'pending'));
