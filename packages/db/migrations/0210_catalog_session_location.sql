-- 0210_catalog_session_location.sql
-- Catalog module (SPK-CAT-001 "location", SPK-CAT-002 individual sessions, SPK-SCHED-008; staff
-- arrival desk "Sessions now", docs/design/park-ui-redesign.md "session location and capacity").
-- An offering names where it takes place (offerings.location: a label and/or scheduling
-- resources); one session of it may take place somewhere more specific (one pitch of the complex,
-- the indoor court on a rainy week). `location` is that session's own place, with the same shape
-- as the offering's ({ label?, resourceIds? }); null means "where the offering is". Resources are
-- referenced by id only (§4.2: no cross-module key); the catalog checks them against the
-- scheduling module's resources at the offering's facility when the session is created.
--
-- Invariants enforced here: a session location is a JSON object; a label, when present, is a
-- non-blank string of at most 200 characters; resourceIds, when present, is an array of at most 50
-- entries; and a location states something (a label or at least one resource).

alter table offering_sessions add column location jsonb;

-- CASE keeps jsonb_array_length / length away from values of another JSON type (the order in which
-- the conditions of a plain AND are evaluated is not guaranteed).
alter table offering_sessions add constraint offering_sessions_location_shape check (
  case
    when location is null then true
    when jsonb_typeof(location) <> 'object' then false
    else
      (case
         when not (location ? 'label') then true
         when jsonb_typeof(location->'label') <> 'string' then false
         else length(btrim(location->>'label')) between 1 and 200
       end)
      and (case
         when not (location ? 'resourceIds') then true
         when jsonb_typeof(location->'resourceIds') <> 'array' then false
         else jsonb_array_length(location->'resourceIds') <= 50
       end)
      and (case
         when location ? 'label' then true
         when jsonb_typeof(location->'resourceIds') = 'array'
           then jsonb_array_length(location->'resourceIds') > 0
         else false
       end)
  end
);
