-- R4-DB-INVARIANTS-08 (§4.3, §4.7 invariant 1): checks the rows written before 0809 against the
-- staff actor keys 0809 added NOT VALID. This is its own migration file, so its own transaction
-- (migrateToLatest): VALIDATE CONSTRAINT takes SHARE UPDATE EXCLUSIVE on the entry table and ROW
-- SHARE on `persons`, which do not block inserts, updates or deletes, while the scans run. Those
-- locks are held until this file commits; 0809's SHARE ROW EXCLUSIVE locks were released when it
-- committed. A row naming a missing person, or a person of another organization, fails this
-- migration (and nothing in it is applied) instead of staying unchecked.

alter table passes validate constraint passes_issued_by_person_fk;
alter table visits validate constraint visits_recorded_by_person_fk;
alter table session_checkins validate constraint session_checkins_recorded_by_person_fk;
alter table attendance_observations validate constraint attendance_observations_recorded_by_person_fk;
alter table departures validate constraint departures_recorded_by_person_fk;
alter table release_records validate constraint release_records_staff_person_fk;
alter table offline_sync_batches validate constraint offline_sync_batches_submitted_by_person_fk;
alter table occupancy_snapshots validate constraint occupancy_snapshots_taken_by_person_fk;
