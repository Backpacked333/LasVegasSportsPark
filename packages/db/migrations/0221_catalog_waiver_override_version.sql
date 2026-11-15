-- 0221_catalog_waiver_override_version.sql
-- Catalog module: a waiver override names the waiver version it was recorded against
-- (SPK-REG-011, proposed amendment PA-01, capability `liability_waivers`, DEC-095).
--
-- An override is a staff decision about one version of a waiver's rule. It lifts the block of
-- that version and of no other: once another version is in force the rule asks again, and that
-- version's own `overrideRoles` decide who may override it. The read that lifts a block matches
-- the override's `policy_version_id` to the version in force, so an override without a version
-- could never lift anything. From this migration every new override states its version.
--
-- `not valid`: rows written before this migration are kept as they are (the table is
-- append-only); the service has always written the version, and a row without one simply lifts
-- no block.
alter table waiver_overrides
  add constraint waiver_overrides_names_version check (policy_version_id is not null) not valid;

-- The read behind every waiver finding: person, family, version, then the activity.
create index waiver_overrides_version_lookup_idx
  on waiver_overrides (
    organization_id, person_id, policy_key, policy_version_id, activity_type, activity_id,
    occurred_at desc
  );
