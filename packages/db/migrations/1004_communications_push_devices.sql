-- 1004_communications_push_devices.sql
-- Communications module (COM-01): push device registration (SPK-UX-001 "push notification
-- registration"), device addressing for the push channel (SPK-COMMS-003/004) and revocation on
-- account recovery (SPK-IAM-006, SPK-AT-025). The push provider is not selected (§5.2, DEC-020):
-- the deterministic fake push adapter addresses these tokens.
--
-- A registration belongs to the account signed in on the device and to that account's person.
-- The platform token is kept only while the registration is active (the push hand-off needs it);
-- revoking erases it, so `token` is null exactly when the device is revoked. Only the SHA-256 hash
-- identifies a token across registrations: one device token is active for at most one
-- registration anywhere (re-registering it for another account revokes the older row first). The
-- token is never returned, logged or audited; responses show `token_hint` (its last characters).

create table push_devices (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  person_id uuid not null,
  account_id uuid not null,
  platform text not null check (platform in ('ios', 'android', 'web')),
  token text check (token is null or length(token) between 1 and 4096),
  token_hash text not null check (token_hash ~ '^[0-9a-f]{64}$'),
  token_hint text not null check (length(token_hint) between 1 and 4),
  app_version text check (app_version is null or length(app_version) between 1 and 50),
  status text not null default 'active' check (status in ('active', 'revoked')),
  registered_at timestamptz not null,
  last_seen_at timestamptz not null,
  revoked_at timestamptz,
  revoked_reason text check (revoked_reason is null or length(revoked_reason) between 1 and 2000),
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, person_id) references persons (organization_id, id),
  foreign key (organization_id, account_id) references accounts (organization_id, id),
  check ((status = 'active') = (token is not null)),
  check ((status = 'revoked') = (revoked_at is not null)),
  check ((status = 'revoked') = (revoked_reason is not null)),
  check (last_seen_at >= registered_at)
);
-- One device token has at most one active registration (a replayed or racing registration of the
-- same token cannot leave two rows that would both be pushed to).
create unique index push_devices_active_token_idx on push_devices (token_hash)
  where status = 'active';
create index push_devices_person_idx on push_devices (organization_id, person_id)
  where status = 'active';
create index push_devices_account_idx on push_devices (organization_id, account_id, registered_at desc);
create trigger push_devices_touch before update on push_devices
  for each row execute function touch_updated_at();
