-- 0530_enrollment_booking_rosters.sql
-- Enrollment module: rental-group rosters (SPK-COND-005, proposed amendment PA-09; Proposed until
-- DEC-103 is answered; capability `rental_rosters`).
--
-- A rental booking (one booking row also covers a standing series of occurrences) may have a
-- group roster: the people the renter brings. The renter or staff invite people; each joins for
-- themselves or for their child; staff see who is on the roster and whose waiver is missing. A
-- roster row is nothing but a name on a list: it is not a team entry, not a registration, not an
-- entitlement, and no other table refers to it.
--
--   * booking_roster_members: one row per person (or invited contact) and booking, `invited`,
--     `joined` or `removed`. One live row per booking and person is a partial unique index.
--   * booking_roster_invitations: the invitation behind an invited row (token hash, expiry,
--     accept, decline, revoke), modelled on team_invitations.
-- The lifecycles are BookingRosterMemberMachine and BookingRosterInvitationMachine
-- (enrollment.state-machines.ts), mirrored by the transition guards below.

create table booking_roster_members (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  booking_id uuid not null,
  person_id uuid,                                    -- null while invited by contact only
  invited_contact_kind text check (invited_contact_kind in ('email', 'phone')),
  invited_contact_value text check (
    invited_contact_value is null or length(invited_contact_value) between 3 and 320
  ),
  status text not null default 'invited' check (status in ('invited', 'joined', 'removed')),
  added_by jsonb not null,
  added_by_person_id uuid,
  joined_at timestamptz,
  removed_at timestamptz,
  removed_by jsonb,
  removal_reason text check (removal_reason is null or length(removal_reason) between 1 and 2000),
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, booking_id) references bookings (organization_id, id),
  foreign key (organization_id, person_id) references persons (organization_id, id),
  foreign key (organization_id, added_by_person_id) references persons (organization_id, id),
  -- A row is about a person or an invited contact.
  constraint booking_roster_members_person_or_contact
    check (person_id is not null or invited_contact_kind is not null),
  check ((invited_contact_kind is null) = (invited_contact_value is null)),
  -- A joined member is a person and has a joining time; a removed row says when.
  constraint booking_roster_members_joined_fact
    check (status <> 'joined' or (person_id is not null and joined_at is not null)),
  constraint booking_roster_members_removed_fact
    check ((status = 'removed') = (removed_at is not null))
);
-- One live member per booking and person.
create unique index booking_roster_members_live_person_idx
  on booking_roster_members (organization_id, booking_id, person_id)
  where status in ('invited', 'joined') and person_id is not null;
-- One open invitation row per booking and contact.
create unique index booking_roster_members_live_contact_idx
  on booking_roster_members (organization_id, booking_id, invited_contact_kind, invited_contact_value)
  where status = 'invited' and person_id is null;
create index booking_roster_members_booking_idx
  on booking_roster_members (organization_id, booking_id, status, created_at, id);
create index booking_roster_members_person_idx
  on booking_roster_members (organization_id, person_id, status) where person_id is not null;
create trigger booking_roster_members_touch before update on booking_roster_members
  for each row execute function touch_updated_at();

-- invited -> joined | removed; joined -> removed; removed is final. The booking never changes;
-- the person is named once (a contact invitation learns its person when it is accepted).
create or replace function booking_roster_members_guard() returns trigger
language plpgsql as $$
begin
  if new.id <> old.id
     or new.organization_id <> old.organization_id
     or new.booking_id <> old.booking_id
     or new.added_by is distinct from old.added_by
     or new.added_by_person_id is distinct from old.added_by_person_id
     or new.created_at <> old.created_at
     or (old.person_id is not null and new.person_id is distinct from old.person_id) then
    raise exception 'booking roster member % cannot change its booking, person or origin', old.id
      using errcode = 'restrict_violation';
  end if;
  if new.status = old.status then
    return new;
  end if;
  if (old.status = 'invited' and new.status in ('joined', 'removed'))
     or (old.status = 'joined' and new.status = 'removed') then
    return new;
  end if;
  raise exception 'booking roster member % cannot move from % to %', old.id, old.status, new.status
    using errcode = 'check_violation', constraint = 'booking_roster_members_machine';
end
$$;
create trigger booking_roster_members_guard before update on booking_roster_members
  for each row execute function booking_roster_members_guard();
create trigger booking_roster_members_no_delete before delete on booking_roster_members
  for each row execute function forbid_mutation();

create table booking_roster_invitations (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  booking_id uuid not null,
  member_id uuid not null,                           -- the roster row this invitation is for
  invited_by jsonb not null,
  invited_by_person_id uuid,
  recipient_person_id uuid,
  recipient_contact_kind text check (recipient_contact_kind in ('email', 'phone')),
  recipient_contact_value text,
  message text check (message is null or length(message) between 1 and 1000),
  token_hash text not null,
  status text not null default 'pending'
    check (status in ('pending', 'accepted', 'declined', 'revoked', 'expired')),
  expires_at timestamptz not null,
  accepted_at timestamptz,
  accepted_by_person_id uuid,                        -- who acted (the person or their guardian)
  declined_at timestamptz,
  revoked_at timestamptz,
  revoked_by jsonb,
  revocation_reason text,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, booking_id) references bookings (organization_id, id),
  foreign key (organization_id, member_id) references booking_roster_members (organization_id, id),
  foreign key (organization_id, invited_by_person_id) references persons (organization_id, id),
  foreign key (organization_id, recipient_person_id) references persons (organization_id, id),
  foreign key (organization_id, accepted_by_person_id) references persons (organization_id, id),
  check ((recipient_person_id is not null) <> (recipient_contact_kind is not null)),
  check ((recipient_contact_kind is null) = (recipient_contact_value is null)),
  check ((status = 'accepted') = (accepted_at is not null)),
  check ((status = 'declined') = (declined_at is not null)),
  check ((status = 'revoked') = (revoked_at is not null))
);
create unique index booking_roster_invitations_token_idx on booking_roster_invitations (token_hash);
-- One pending invitation per roster row.
create unique index booking_roster_invitations_pending_idx
  on booking_roster_invitations (organization_id, member_id) where status = 'pending';
create index booking_roster_invitations_booking_idx
  on booking_roster_invitations (organization_id, booking_id, status);
create index booking_roster_invitations_recipient_idx
  on booking_roster_invitations (organization_id, recipient_person_id, status)
  where recipient_person_id is not null;
create trigger booking_roster_invitations_touch before update on booking_roster_invitations
  for each row execute function touch_updated_at();

-- pending -> accepted | declined | revoked | expired; every other state is final. Who was invited,
-- to what, by whom and with which token never changes.
create or replace function booking_roster_invitations_guard() returns trigger
language plpgsql as $$
begin
  if new.id <> old.id
     or new.organization_id <> old.organization_id
     or new.booking_id <> old.booking_id
     or new.member_id <> old.member_id
     or new.recipient_person_id is distinct from old.recipient_person_id
     or new.recipient_contact_kind is distinct from old.recipient_contact_kind
     or new.recipient_contact_value is distinct from old.recipient_contact_value
     or new.token_hash <> old.token_hash
     or new.expires_at <> old.expires_at
     or new.created_at <> old.created_at then
    raise exception 'booking roster invitation % cannot be rewritten', old.id
      using errcode = 'restrict_violation';
  end if;
  if new.status = old.status then
    return new;
  end if;
  if old.status = 'pending' and new.status in ('accepted', 'declined', 'revoked', 'expired') then
    return new;
  end if;
  raise exception 'booking roster invitation % cannot move from % to %', old.id, old.status, new.status
    using errcode = 'check_violation', constraint = 'booking_roster_invitations_machine';
end
$$;
create trigger booking_roster_invitations_guard before update on booking_roster_invitations
  for each row execute function booking_roster_invitations_guard();
create trigger booking_roster_invitations_no_delete before delete on booking_roster_invitations
  for each row execute function forbid_mutation();
