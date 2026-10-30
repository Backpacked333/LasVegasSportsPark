-- 1009_communications_follow_up_references.sql
-- Communications module, INTEGRITY-07 (§4.3, CLAUDE.md data rules): the two follow-up ledgers
-- added in 1007 and 1008 name records of other modules by id only. They now reference them with
-- the organization-scoped composite key, so a mark can never name an event or a merge that does
-- not exist or belongs to another organization:
--
-- - reminder_marks.scheduling_event_id -> events (organization_id, id): the reminder job writes a
--   mark for an event it read through the scheduling port in the same transaction.
-- - communication_merge_follow_ups.merge_id -> person_merges (organization_id, id): the
--   identity.person_merged follow-up writes one row per merge identity recorded.
--
-- Scheduling never deletes an event and identity never deletes a merge, so neither reference can
-- block their writers. Both tables are append-only (forbid_mutation), so no row changes after it
-- is checked here.

alter table reminder_marks
  add constraint reminder_marks_event_fk
    foreign key (organization_id, scheduling_event_id) references events (organization_id, id);

alter table communication_merge_follow_ups
  add constraint communication_merge_follow_ups_merge_fk
    foreign key (organization_id, merge_id) references person_merges (organization_id, id);
