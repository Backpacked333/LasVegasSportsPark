-- 0105_identity_expiry_indexes.sql
-- §4.12 background work (ID-07, ID-08): the periodic jobs identity.expire_invitations_and_claims
-- and identity.end_elapsed_restrictions scan every organization for rows whose time has passed.
-- These partial indexes keep each pass to the due rows. Durations are unchanged (POL-044).
create index invitations_pending_expiry_idx on invitations (expires_at) where status = 'pending';
create index claims_pending_expiry_idx on claims (expires_at) where status = 'pending';
create index access_grant_suspensions_window_idx
  on access_grant_suspensions (suspended_until)
  where ended_at is null and suspended_until is not null;
