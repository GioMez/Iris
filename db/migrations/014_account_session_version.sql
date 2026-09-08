-- An integer generation revokes sessions even when issued and reset in one second.
-- Retain session_epoch, but session_version is now the authentication authority.
ALTER TABLE users
  ADD COLUMN session_version INTEGER NOT NULL DEFAULT 0 CHECK (session_version >= 0);
