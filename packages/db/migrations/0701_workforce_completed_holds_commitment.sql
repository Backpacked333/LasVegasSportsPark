-- SPK-STAFF-003, §4.7: a completed assignment keeps holding its committed interval (the scheduled
-- interval plus the turnaround). Completion is allowed as soon as the activity has started, so
-- without this a person completed at kickoff could accept other work overlapping the game still
-- in progress, or inside its turnaround. Completed rows are never retimed, and past ones never
-- collide with future work. The constraint keeps its name so the service still maps a violation to
-- RESOURCE_CONFLICT naming `assignments_no_overlap`.
alter table assignments drop constraint assignments_no_overlap;
alter table assignments add constraint assignments_no_overlap
  exclude using gist (organization_id with =, person_id with =, committed with &&)
  where (status in ('accepted', 'completed'));
