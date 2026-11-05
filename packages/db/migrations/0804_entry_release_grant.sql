-- 0804_entry_release_grant.sql
-- ENT-02: SPK-ENTRY-007 ("verify current pickup authority and record ... verification outcome"),
-- §4.7 (integrity enforced in the database), IF-46 (AuthorityLookupPort.effectiveGrant).
--
-- A verified online release now names the identity access grant its `collect` check relied on,
-- so the evidence points at the exact grant (and through it the relationship and any access
-- review that later suspends it) instead of only `relationship_permission:collect`. The grant is
-- referenced with the organization-scoped composite key (§4.3), so a release can never name
-- another organization's grant.
alter table release_records
  add column authority_grant_id uuid,
  add constraint release_records_authority_grant_fk
    foreign key (organization_id, authority_grant_id) references access_grants (organization_id, id),
  -- Only a verified online check names a grant; denials, escalations and the outage procedure never do.
  add constraint release_records_grant_only_when_verified
    check (authority_grant_id is null or verification_outcome = 'verified');

-- Every new verified release names its grant. Release records are append-only, so the rows written
-- before this migration (which could not know the grant) are not rewritten: NOT VALID checks every
-- new row without validating the existing ones.
alter table release_records
  add constraint release_records_verified_names_grant
    check (verification_outcome <> 'verified' or authority_grant_id is not null) not valid;
