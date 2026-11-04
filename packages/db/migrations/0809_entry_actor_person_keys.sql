-- R4-DB-INVARIANTS-08 (§4.3, §4.7 invariant 1, CLAUDE.md data rules; completes INTEGRITY-07). The
-- staff actor columns of the entry tables reference the person with the organization-scoped
-- composite key, so a record can never name an actor who does not exist or belongs to another
-- organization. 0806's header says every `*_by_person_id` of the entry tables was already keyed;
-- that was true only of `access_devices.registered_by_person_id` (corrected here and in the README,
-- since applied migrations do not change). Four of these tables are append-only (attendance
-- observations, departures, release records, offline batches), so a wrong actor could never be
-- corrected afterwards: release_records.staff_person_id is the safeguarding evidence of who handed
-- a child over (SPK-ENTRY-007).
--
-- Every writer stores the signed-in principal's person (null for a system principal, which the
-- keys allow); identity never deletes a person (a merged person's row stays). The keys are added
-- NOT VALID and then validated, so existing rows are checked without a long exclusive lock.

alter table passes
  add constraint passes_issued_by_person_fk
    foreign key (organization_id, issued_by_person_id) references persons (organization_id, id)
    not valid;
alter table visits
  add constraint visits_recorded_by_person_fk
    foreign key (organization_id, recorded_by_person_id) references persons (organization_id, id)
    not valid;
alter table session_checkins
  add constraint session_checkins_recorded_by_person_fk
    foreign key (organization_id, recorded_by_person_id) references persons (organization_id, id)
    not valid;
alter table attendance_observations
  add constraint attendance_observations_recorded_by_person_fk
    foreign key (organization_id, recorded_by_person_id) references persons (organization_id, id)
    not valid;
alter table departures
  add constraint departures_recorded_by_person_fk
    foreign key (organization_id, recorded_by_person_id) references persons (organization_id, id)
    not valid;
alter table release_records
  add constraint release_records_staff_person_fk
    foreign key (organization_id, staff_person_id) references persons (organization_id, id)
    not valid;
alter table offline_sync_batches
  add constraint offline_sync_batches_submitted_by_person_fk
    foreign key (organization_id, submitted_by_person_id) references persons (organization_id, id)
    not valid;
alter table occupancy_snapshots
  add constraint occupancy_snapshots_taken_by_person_fk
    foreign key (organization_id, taken_by_person_id) references persons (organization_id, id)
    not valid;

alter table passes validate constraint passes_issued_by_person_fk;
alter table visits validate constraint visits_recorded_by_person_fk;
alter table session_checkins validate constraint session_checkins_recorded_by_person_fk;
alter table attendance_observations validate constraint attendance_observations_recorded_by_person_fk;
alter table departures validate constraint departures_recorded_by_person_fk;
alter table release_records validate constraint release_records_staff_person_fk;
alter table offline_sync_batches validate constraint offline_sync_batches_submitted_by_person_fk;
alter table occupancy_snapshots validate constraint occupancy_snapshots_taken_by_person_fk;
