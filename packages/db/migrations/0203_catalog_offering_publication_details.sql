-- 0203_catalog_offering_publication_details.sql
-- Catalog module: SPK-CAT-001 "an offering must specify name and description, format, location"
-- and SPK-CAT-004 "publication must validate required configuration". Migration 0200 is applied
-- and immutable; its check `offerings_published_configuration_complete` did not cover the
-- description, the format or the location, so a published offering could be listed publicly with
-- neither. This file replaces the check with one that also requires, beyond draft and archived:
-- a non-blank description, a non-blank format (the offering's own, copied from its program when
-- it was created) and a location with a label or at least one space.

alter table offerings drop constraint offerings_published_configuration_complete;
alter table offerings add constraint offerings_published_configuration_complete check (
  publication_state in ('draft', 'archived') or (
    registration_opens_at is not null
    and registration_closes_at is not null
    and eligibility_policy_version_id is not null
    and entitlement_definition_id is not null
    and cancellation_policy_version_id is not null
    and responsible_manager_person_id is not null
    and jsonb_array_length(capacity_units) > 0
    and length(btrim(coalesce(description, ''))) > 0
    and length(btrim(coalesce(format, ''))) > 0
    and (
      length(btrim(coalesce(location->>'label', ''))) > 0
      or case
           when jsonb_typeof(location->'resourceIds') = 'array'
             then jsonb_array_length(location->'resourceIds') > 0
           else false
         end
    )
  )
);
