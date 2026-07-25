-- Project storage locations become relative to DATA_DIR.
--
-- Absolute paths tie a database dump to one host layout: restoring it next to a
-- filesystem backup mounted elsewhere would leave every project unreachable.
-- The canonical location is derived from the project id alone, so ownership is
-- recorded only in the database and never in the directory tree. That keeps the
-- layout stable when a project gains further members or changes owner.
--
-- The previous absolute path is preserved in legacy_storage_path until the
-- directories have been relocated on disk; the application clears it one row at
-- a time as each move completes.

ALTER TABLE projects ADD COLUMN legacy_storage_path VARCHAR(512);

UPDATE projects
SET legacy_storage_path = storage_path
WHERE storage_path ~ '^(/|[A-Za-z]:[\\/])';

UPDATE projects SET storage_path = 'projects/' || id;

ALTER TABLE projects
  ADD CONSTRAINT projects_storage_path_relative CHECK (
    storage_path <> ''
    AND storage_path !~ '^(/|[A-Za-z]:[\\/])'
    AND storage_path NOT LIKE '%..%'
  );
