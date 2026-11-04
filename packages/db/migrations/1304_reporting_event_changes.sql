-- 1304_reporting_event_changes.sql
-- Reporting module (R3-REPORTING-01; SPK-REPORT-002 daily schedule, metric dictionary MET-002,
-- SPK-SCHED-005, SPK-COMMS-005): which of a day's activities differ from what customers were first
-- told. The metric dictionary defines it from the scheduling module's `scheduling.event_changed`
-- facts: an event changed after its first publication has a fact of change `moved`, `resized`,
-- `resource_changed` (or `updated`), and a canceled published event one of change `canceled`.
--
-- `events.published_revision` is the revision at which the event was last published, not a count
-- of publications: a draft first published by a schedule-draft change targeting it is published at
-- revision 2 or later (SPK-FIX-005), so `published_revision > 1` cannot tell a change from a first
-- publication. The scheduling module records every customer-visible change as a durable domain
-- event in the producing transaction (§4.12 "events are durable facts consumers may replay"),
-- stamped with the injected clock: a first publication is `created` or `published`, and a change
-- to a draft event emits no fact at all (a schedule draft's move, resize or resource change needs
-- a published target). This view exposes those facts so a report evaluated as of an instant sees
-- exactly the changes recorded by then (metric dictionary G3).
--
-- Only identifiers, the change kind and instants are exposed: the payload's practical details
-- (titles, resources, commitments) stay with the scheduling and communications modules. The view
-- keeps only `scheduling.event_changed` facts, so its `change` is untyped text (like the status of
-- `reporting_resource_status_changes_v`, migration 1302).

create view reporting_event_changes_v as
  select o.id as change_id, o.organization_id, e.facility_id, e.id as event_id,
         o.payload ->> 'change' as change, o.occurred_at as changed_at,
         (o.payload ->> 'revision')::integer as revision,
         o.payload ->> 'publicationId' as publication_id,
         o.payload ->> 'closureId' as closure_id
  from outbox_events o
  join events e on e.organization_id = o.organization_id and e.id::text = o.aggregate_id
  where o.event_type = 'scheduling.event_changed'
    and o.aggregate_type = 'event';

create trigger reporting_event_changes_v_read_only
  instead of insert or update or delete on reporting_event_changes_v
  for each row execute function reporting_view_read_only();
