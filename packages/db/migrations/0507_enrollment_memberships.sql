-- 0507_enrollment_memberships.sql
-- Enrollment module, ENR-12: memberships (§3.16 Memberships row, SPK-COND-001). Whether the
-- complex sells memberships is pending (DEC-016, DEC-072); the commands that sell, renew or book
-- through one check the organization's `memberships` capability switch. Benefit, term and renewal
-- content is configuration (POL-038): a membership's attendance is exactly what its definition
-- states, never an implied unlimited.
--
--   * enrollments gains the membership term (set when the membership is confirmed) and the
--     membership a renewal continues;
--   * membership_suspensions: pauses of a membership; two active pauses of one membership never
--     overlap (exclusion constraint);
--   * membership_benefit_uses: the included sessions used per period; the check is the guarantee
--     that a membership never books beyond its stated entitlement, even under concurrency;
--   * session_bookings gains the membership basis, the membership and the benefit period.

alter table enrollments add column membership_starts_at timestamptz;
alter table enrollments add column membership_ends_at timestamptz;
alter table enrollments add column renewed_from_enrollment_id uuid;
-- When the one renewal_opportunity notice of a membership was composed (IF-22).
alter table enrollments add column renewal_notice_at timestamptz;
alter table enrollments add constraint enrollments_renewed_from_fk
  foreign key (organization_id, renewed_from_enrollment_id) references enrollments (organization_id, id);
alter table enrollments add constraint enrollments_membership_term
  check (
    (membership_starts_at is null) = (membership_ends_at is null)
    and (membership_starts_at is null or membership_starts_at < membership_ends_at)
  );
alter table enrollments add constraint enrollments_membership_term_only_memberships
  check (membership_starts_at is null or intent = 'membership');
alter table enrollments add constraint enrollments_renewal_notice_only_memberships
  check (renewal_notice_at is null or intent = 'membership');
alter table enrollments add constraint enrollments_renewal_only_memberships
  check (renewed_from_enrollment_id is null or (intent = 'membership' and renewed_from_enrollment_id <> id));
-- One live renewal per membership.
create unique index enrollments_one_live_renewal_idx
  on enrollments (organization_id, renewed_from_enrollment_id)
  where renewed_from_enrollment_id is not null and status in ('pending', 'confirmed');
create index enrollments_membership_term_idx
  on enrollments (organization_id, membership_ends_at)
  where intent = 'membership' and status = 'confirmed';

alter table basket_lines add column renewed_from_enrollment_id uuid;
alter table basket_lines add constraint basket_lines_renewed_from_fk
  foreign key (organization_id, renewed_from_enrollment_id) references enrollments (organization_id, id);
alter table basket_lines add constraint basket_lines_renewal_only_memberships
  check (renewed_from_enrollment_id is null or intent = 'membership');

create table membership_suspensions (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  enrollment_id uuid not null,
  participant_person_id uuid not null,
  suspended_from timestamptz not null,
  suspended_until timestamptz,                       -- null: until ended
  reason text not null check (length(reason) between 1 and 2000),
  status text not null default 'active' check (status in ('active', 'ended')),
  created_by jsonb not null,
  created_by_person_id uuid,
  ended_at timestamptz,
  ended_reason text check (ended_reason is null or length(ended_reason) between 1 and 2000),
  ended_by jsonb,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, enrollment_id) references enrollments (organization_id, id),
  foreign key (organization_id, participant_person_id) references persons (organization_id, id),
  foreign key (organization_id, created_by_person_id) references persons (organization_id, id),
  check (suspended_until is null or suspended_from < suspended_until),
  constraint membership_suspensions_ended_fact check ((status = 'ended') = (ended_at is not null)),
  -- Two active pauses of one membership never overlap.
  constraint membership_suspensions_no_overlap exclude using gist (
    organization_id with =,
    enrollment_id with =,
    tstzrange(suspended_from, coalesce(suspended_until, 'infinity'::timestamptz), '[)') with &&
  ) where (status = 'active')
);
create index membership_suspensions_enrollment_idx
  on membership_suspensions (organization_id, enrollment_id, suspended_from);
create index membership_suspensions_elapsing_idx
  on membership_suspensions (organization_id, suspended_until)
  where status = 'active' and suspended_until is not null;
create trigger membership_suspensions_touch before update on membership_suspensions
  for each row execute function touch_updated_at();

-- MembershipSuspensionMachine (§4.6, ENR-10): active → ended; ended is final.
create or replace function membership_suspensions_transition_guard() returns trigger
language plpgsql as $$
begin
  if new.status = old.status then
    return new;
  end if;
  if old.status = 'active' and new.status = 'ended' then
    return new;
  end if;
  raise exception 'membership suspension % cannot move from % to %', old.id, old.status, new.status
    using errcode = 'check_violation', constraint = 'membership_suspensions_machine';
end
$$;
create trigger membership_suspensions_transition_guard before update on membership_suspensions
  for each row execute function membership_suspensions_transition_guard();

create table membership_benefit_uses (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  enrollment_id uuid not null,
  period_key text not null check (period_key ~ '^(week:[0-9]{4}-[0-9]{2}-[0-9]{2}|month:[0-9]{4}-[0-9]{2}|term)$'),
  used_count integer not null default 0 check (used_count >= 0),
  limit_count integer not null check (limit_count >= 1),
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, enrollment_id, period_key),
  foreign key (organization_id, enrollment_id) references enrollments (organization_id, id),
  -- SPK-COND-001: a limited membership never books beyond its stated entitlement.
  constraint membership_benefit_uses_within_limit check (used_count <= limit_count)
);
create trigger membership_benefit_uses_touch before update on membership_benefit_uses
  for each row execute function touch_updated_at();

alter table session_bookings add column membership_enrollment_id uuid;
alter table session_bookings add column membership_period_key text;
alter table session_bookings add constraint session_bookings_membership_fk
  foreign key (organization_id, membership_enrollment_id) references enrollments (organization_id, id);
alter table session_bookings drop constraint session_bookings_entitlement_basis_check;
alter table session_bookings add constraint session_bookings_entitlement_basis_check
  check (entitlement_basis in ('purchase', 'makeup', 'package', 'membership'));
-- A membership booking always names its membership, and only a membership booking does.
alter table session_bookings add constraint session_bookings_membership_basis
  check ((entitlement_basis = 'membership') = (membership_enrollment_id is not null));
alter table session_bookings add constraint session_bookings_membership_period
  check (membership_period_key is null or entitlement_basis = 'membership');
alter table session_bookings drop constraint session_bookings_credit_disposition_fact;
alter table session_bookings add constraint session_bookings_credit_disposition_fact
  check (credit_disposition is null or (status = 'canceled' and entitlement_basis in ('package', 'membership')));
create index session_bookings_membership_idx on session_bookings (organization_id, membership_enrollment_id)
  where membership_enrollment_id is not null;
