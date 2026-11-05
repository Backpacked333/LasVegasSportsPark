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
-- keys allow); identity never deletes a person (a merged person's row stays).
--
-- Locking: migrateToLatest runs each migration file in one transaction, and every lock taken in
-- it is held until that transaction commits. Each `add constraint ... foreign key ... not valid`
-- takes SHARE ROW EXCLUSIVE on its entry table and on `persons` (writes to them wait), but checks
-- no existing row, so this file holds those locks only for the catalog changes. New and updated
-- rows are checked from here on. Existing rows are checked by 0810 in its own transaction:
-- VALIDATE CONSTRAINT takes only SHARE UPDATE EXCLUSIVE on the entry table and ROW SHARE on
-- `persons`, so writes continue while it scans. Validating in this file would scan every table
-- while the SHARE ROW EXCLUSIVE locks above are still held.

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
