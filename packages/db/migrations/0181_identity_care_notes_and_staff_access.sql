-- Identity: operational care notes on a person, staff access reviews and staff invitations.
--
-- (1) Care notes (§1.7 "not a medical assessment system", SPK-DISC-005, §4.14 child information
--     minimized, SPK-ENTRY-004 actionable arrival information): short operational notes the desk
--     and program staff need to keep a participant safe (an allergy and what to do, a care
--     instruction). They are not a diagnosis, an assessment or medical advice; the kinds are
--     limited to the two operational ones. A note's text never changes: a correction retires the
--     note (reason kept) and records a new one.
-- (2) Staff access reviews (§4.14 least privilege, audited privileged actions): an append-only
--     record that a second administrator reviewed one staff member's roles, with the date the
--     reviewer sets for the next review. Nobody reviews their own access.
-- (3) Staff invitations (§2.1 system administrator: accounts and permissions; SPK-IAM-004 applied
--     to staff roles): an administrator invites an email address to take staff roles at a
--     facility scope; acceptance by the person holding that verified email creates exactly one
--     staff membership with those roles.

create table person_care_notes (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  person_id uuid not null,
  kind text not null check (kind in ('allergy', 'care_instruction')),
  body text not null check (length(btrim(body)) between 1 and 500),
  status text not null default 'active' check (status in ('active', 'retired')),
  recorded_by jsonb not null,
  recorded_by_person_id uuid,
  retired_at timestamptz,
  retired_by jsonb,
  retired_reason text,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, person_id) references persons (organization_id, id),
  foreign key (organization_id, recorded_by_person_id) references persons (organization_id, id),
  check ((status = 'retired') = (retired_at is not null)),
  check (status = 'active' or (retired_reason is not null and length(btrim(retired_reason)) > 0))
);
create index person_care_notes_person_idx on person_care_notes (organization_id, person_id)
  where status = 'active';
create trigger person_care_notes_touch before update on person_care_notes
  for each row execute function touch_updated_at();

-- A note is never rewritten or deleted (§4.7): only `active -> retired` with its facts.
create function person_care_notes_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'person_care_notes rows cannot be deleted; retire the note instead'
      using errcode = 'P0001';
  end if;
  if new.person_id is distinct from old.person_id
     or new.kind is distinct from old.kind
     or new.body is distinct from old.body
     or new.recorded_by is distinct from old.recorded_by
     or new.recorded_by_person_id is distinct from old.recorded_by_person_id
     or new.created_at is distinct from old.created_at then
    raise exception 'a care note is never rewritten; retire it and record a new one'
      using errcode = 'P0001';
  end if;
  if old.status = 'retired' then
    raise exception 'a retired care note cannot change' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger person_care_notes_immutable before update or delete on person_care_notes
  for each row execute function person_care_notes_guard();

create table staff_access_reviews (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  person_id uuid not null,
  outcome text not null check (outcome in ('confirmed', 'changes_required')),
  notes text check (notes is null or length(notes) <= 2000),
  roles_reviewed text[] not null,
  reviewed_by jsonb not null,
  reviewed_by_person_id uuid not null,
  reviewed_at timestamptz not null,
  next_review_due_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, person_id) references persons (organization_id, id),
  foreign key (organization_id, reviewed_by_person_id) references persons (organization_id, id),
  check (reviewed_by_person_id <> person_id),
  check (next_review_due_at > reviewed_at)
);
create index staff_access_reviews_person_idx
  on staff_access_reviews (organization_id, person_id, reviewed_at desc);
create trigger staff_access_reviews_append_only before update or delete on staff_access_reviews
  for each row execute function forbid_mutation();

create table staff_invitations (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  recipient_email text not null check (
    length(recipient_email) between 3 and 320 and recipient_email = lower(btrim(recipient_email))
  ),
  roles text[] not null check (
    cardinality(roles) >= 1
    and roles <@ array['front_desk', 'league_manager', 'program_manager', 'scheduler', 'finance_operator',
                       'facilities_operator', 'general_manager', 'system_administrator', 'support_operator',
                       'coach', 'official']::text[]
  ),
  facility_ids uuid[] not null default '{}',
  invited_by jsonb not null,
  invited_by_person_id uuid not null,
  token_hash text not null unique,
  status text not null default 'pending'
    check (status in ('pending', 'accepted', 'revoked', 'expired')),
  expires_at timestamptz not null,
  accepted_at timestamptz,
  accepted_by_person_id uuid,
  staff_membership_id uuid,
  revoked_at timestamptz,
  revoked_by jsonb,
  revocation_reason text,
  expired_at timestamptz,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, invited_by_person_id) references persons (organization_id, id),
  foreign key (organization_id, accepted_by_person_id) references persons (organization_id, id),
  foreign key (organization_id, staff_membership_id)
    references staff_memberships (organization_id, id),
  check (expires_at > created_at),
  check ((status = 'accepted') = (accepted_at is not null)),
  check (status <> 'accepted' or (accepted_by_person_id is not null and staff_membership_id is not null)),
  check ((status = 'revoked') = (revoked_at is not null)),
  check (status <> 'revoked' or revocation_reason is not null),
  check ((status = 'expired') = (expired_at is not null))
);
-- One open invitation per address: a second one would make "which roles?" ambiguous.
create unique index staff_invitations_one_pending_idx
  on staff_invitations (organization_id, recipient_email) where status = 'pending';
-- An invitation creates at most one membership, and a membership comes from at most one invitation.
create unique index staff_invitations_membership_idx
  on staff_invitations (organization_id, staff_membership_id) where staff_membership_id is not null;
create index staff_invitations_created_idx on staff_invitations (organization_id, created_at desc, id desc);
create trigger staff_invitations_touch before update on staff_invitations
  for each row execute function touch_updated_at();

-- Last seen for the accounts screen reads accounts by person.
create index if not exists accounts_person_last_login_idx
  on accounts (organization_id, person_id, last_login_at desc);
