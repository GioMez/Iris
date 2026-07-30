-- Realtime collaboration (OT) consolidates a burst of live edits into a single
-- revision instead of recording one per keystroke, so the new 'realtime' reason
-- distinguishes those consolidated checkpoints from the deliberate ones a user
-- asked for ('manual'), a compilation captured ('compile'), a rollback appended
-- ('rollback') or a file was created with ('initial').
ALTER TABLE document_versions DROP CONSTRAINT document_versions_reason_check;
ALTER TABLE document_versions ADD CONSTRAINT document_versions_reason_check
  CHECK (reason IN ('manual', 'compile', 'rollback', 'initial', 'realtime'));
