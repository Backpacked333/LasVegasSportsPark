-- 0908_facilities_manual_restricted_assets.sql
-- Facilities module, R4-MODULE-BOUNDARIES-02 follow-up (SPK-FAC-003 "restrictions close an area or
-- equipment for an interval", SPK-FAC-004 "an authorized release returns it to service",
-- SPK-COND-003 equipment for a booking).
--
-- An asset's `restricted` status is now set only by an operating restriction's approval and lifted
-- by its release: asset create and update refuse `restricted` (the contract excludes it), and the
-- manual unusable state is `out_of_service`, which a release leaves as it is. Before this change a
-- person could set `restricted` by hand. Such an asset carries no restriction of its own, so
-- enrollment (which decides a booking's equipment by the restrictions' windows) could not tell why
-- it is restricted, and a later release of an unrelated restriction returned it to service.
--
-- Existing assets set `restricted` with no approved or active restriction naming them are moved to
-- `out_of_service` (the state that says a person, not a restriction, took them out), with their
-- revision bumped and one audit record each, so the change is visible in the asset's history.

with moved as (
  update assets a
     set status = 'out_of_service',
         revision = a.revision + 1
   where a.status = 'restricted'
     and not exists (
       select 1
         from restrictions r
        where r.organization_id = a.organization_id
          and r.asset_id = a.id
          and r.status in ('approved', 'active')
     )
  returning a.id, a.organization_id, a.revision
)
insert into audit_records (
  id, organization_id, actor, action, target_type, target_id, before_revision, after_revision,
  reason, details
)
select gen_random_uuid(), m.organization_id, '{"kind":"system"}'::jsonb, 'facilities.asset_updated',
       'asset', m.id::text, m.revision - 1, m.revision,
       'Restricted without an operating restriction: marked out of service (migration 0908)',
       '{"status":"out_of_service","migration":"0908_facilities_manual_restricted_assets"}'::jsonb
  from moved m;
