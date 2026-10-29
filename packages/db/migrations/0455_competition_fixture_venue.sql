-- 0455_competition_fixture_venue.sql
-- CMP-04 (SPK-SCHED-008, SPK-UX-004, §4.12): a fixture keeps a read model of its venue, copied
-- from the scheduling module's `scheduling.event_changed` facts (`after`: facility, IANA time zone
-- and the resources with their names). Scheduling stays the authority for time and space; the
-- copy is replaced only by a change of the fixture's current event with a newer event revision
-- (`venue_event_revision`), so a late delivery never overwrites a newer venue. Fixtures created
-- before this migration read a null venue until their event next changes.
alter table fixtures
  add column venue_facility_id uuid,
  add column venue jsonb,
  add column venue_event_revision integer;

alter table fixtures
  add constraint fixtures_venue_facility_fk
    foreign key (organization_id, venue_facility_id) references facilities (organization_id, id),
  -- the facility column and the copied venue are present together or not at all
  add constraint fixtures_venue_presence check ((venue is null) = (venue_facility_id is null)),
  add constraint fixtures_venue_shape check (
    venue is null
    or (jsonb_typeof(venue) = 'object' and venue ->> 'facilityId' = venue_facility_id::text)
  ),
  add constraint fixtures_venue_revision check (
    (venue_event_revision is null or venue_event_revision >= 1)
    and (venue is not null or venue_event_revision is null)
  );
