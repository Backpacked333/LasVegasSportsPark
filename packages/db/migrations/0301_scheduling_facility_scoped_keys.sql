-- 0301_scheduling_facility_scoped_keys.sql
-- Scheduling module: facility boundaries enforced by the database (§4.3 facility boundaries,
-- §4.7 "integrity that matters is enforced in the database", CLAUDE.md composite foreign keys).
-- Authorization is facility-scoped, so a row whose facility is A must never name a resource or an
-- event of facility B: the service checks (`resource.facilityId !== facility.id`) give the early
-- answer, these keys are the guarantee. Migration 0300 is applied and immutable; this file adds:
--
-- 1. Facility-scoped keys `unique (organization_id, facility_id, id)` on resources, events and
--    closures, the targets of the references below and of the facilities module's own (0902).
-- 2. A subdivision's parent, a closure's resource and an operating-hours window's resource belong
--    to the row's own facility.
-- 3. Reservations carry their facility (backfilled from the event) and reference the event and the
--    resource through it, so a reservation never joins an event of one facility to a resource of
--    another.

alter table resources
  add constraint resources_facility_scoped_key unique (organization_id, facility_id, id);
alter table events
  add constraint events_facility_scoped_key unique (organization_id, facility_id, id);
alter table closures
  add constraint closures_facility_scoped_key unique (organization_id, facility_id, id);

alter table resources
  add constraint resources_parent_same_facility
    foreign key (organization_id, facility_id, parent_resource_id)
    references resources (organization_id, facility_id, id);

alter table closures
  add constraint closures_resource_same_facility
    foreign key (organization_id, facility_id, resource_id)
    references resources (organization_id, facility_id, id);

alter table operating_hours
  add constraint operating_hours_resource_same_facility
    foreign key (organization_id, facility_id, resource_id)
    references resources (organization_id, facility_id, id) on delete cascade;

alter table reservations add column facility_id uuid;
update reservations r
  set facility_id = e.facility_id
  from events e
  where e.organization_id = r.organization_id and e.id = r.event_id;
alter table reservations
  alter column facility_id set not null,
  add constraint reservations_event_same_facility
    foreign key (organization_id, facility_id, event_id)
    references events (organization_id, facility_id, id),
  add constraint reservations_resource_same_facility
    foreign key (organization_id, facility_id, resource_id)
    references resources (organization_id, facility_id, id);
