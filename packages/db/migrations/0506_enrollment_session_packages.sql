-- 0506_enrollment_session_packages.sql
-- Enrollment module, ENR-11: session packages (§3.16 Session packages row, SPK-COND-002,
-- SPK-AT-020, §4.7 invariant 7). Whether the complex sells packages is pending (DEC-016,
-- DEC-074); the commands that sell or redeem them check the organization's `session_packages`
-- capability switch. Expiry and credit return are configuration (POL-039, POL-007): this
-- migration stores what the package definition and the approved cancellation policy say and
-- invents no value.
--
--   * package_entitlements: the credits one confirmed package purchase (an enrollment with intent
--     package_purchase) grants its participant. The checks make the database refuse a redemption
--     beyond the credits; status follows PackageEntitlementMachine (enrollment.state-machines.ts).
--   * package_redemptions: append-only redemption history; a correction is a reversal row that
--     references the redemption it corrects (forbid_mutation). The trigger
--     package_redemptions_apply locks the entitlement and moves its count and status, so two
--     concurrent redemptions of the last credit can never both succeed (SPK-AT-020).
--   * session_bookings gains the basis of its entitlement (purchase, makeup or package), the
--     package entitlement it redeemed and, when canceled, what happened to the credit.

create table package_entitlements (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  participant_person_id uuid not null,
  enrollment_id uuid not null,                       -- the confirmed package purchase
  entitlement_definition_id uuid not null,
  offering_id uuid not null,                         -- the package offering
  applies_to_offering_ids jsonb not null default '[]'::jsonb,
  applies_to_program_ids jsonb not null default '[]'::jsonb,
  credits integer not null check (credits between 1 and 1000),
  redeemed_count integer not null default 0 check (redeemed_count >= 0),
  status text not null default 'active' check (status in ('active', 'exhausted', 'expired', 'revoked')),
  expires_at timestamptz,                            -- null: the definition chose no expiry
  issued_at timestamptz not null,
  expired_at timestamptz,
  revoked_at timestamptz,
  revoked_reason text check (revoked_reason is null or length(revoked_reason) between 1 and 2000),
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  -- One entitlement per purchase: issuing twice (a replayed confirmation) is a no-op.
  unique (organization_id, enrollment_id),
  foreign key (organization_id, participant_person_id) references persons (organization_id, id),
  foreign key (organization_id, enrollment_id) references enrollments (organization_id, id),
  foreign key (organization_id, entitlement_definition_id) references entitlement_definitions (organization_id, id),
  foreign key (organization_id, offering_id) references offerings (organization_id, id),
  check (jsonb_typeof(applies_to_offering_ids) = 'array' and jsonb_typeof(applies_to_program_ids) = 'array'),
  -- SPK-AT-020: the database refuses the redemption that would exceed the credits.
  constraint package_entitlements_within_limit check (redeemed_count <= credits),
  constraint package_entitlements_exhausted_fact check (status <> 'exhausted' or redeemed_count = credits),
  constraint package_entitlements_active_has_room check (status <> 'active' or redeemed_count < credits),
  constraint package_entitlements_revoked_fact check ((status = 'revoked') = (revoked_at is not null)),
  constraint package_entitlements_expired_fact check ((status = 'expired') = (expired_at is not null))
);
create index package_entitlements_participant_idx
  on package_entitlements (organization_id, participant_person_id, created_at desc, id);
create index package_entitlements_created_idx
  on package_entitlements (organization_id, created_at desc, id);
create index package_entitlements_expiry_idx
  on package_entitlements (organization_id, expires_at) where status = 'active' and expires_at is not null;
create trigger package_entitlements_touch before update on package_entitlements
  for each row execute function touch_updated_at();

-- PackageEntitlementMachine (§4.6, ENR-10): active → exhausted | expired | revoked;
-- exhausted → active (a reversal) | revoked; expired and revoked are final.
create or replace function package_entitlements_transition_guard() returns trigger
language plpgsql as $$
begin
  if new.status = old.status then
    return new;
  end if;
  if (old.status = 'active' and new.status in ('exhausted', 'expired', 'revoked'))
     or (old.status = 'exhausted' and new.status in ('active', 'revoked')) then
    return new;
  end if;
  raise exception 'package entitlement % cannot move from % to %', old.id, old.status, new.status
    using errcode = 'check_violation', constraint = 'package_entitlements_machine';
end
$$;
create trigger package_entitlements_transition_guard before update on package_entitlements
  for each row execute function package_entitlements_transition_guard();

-- Session bookings: the basis of the entitlement a booking uses.
alter table session_bookings add column entitlement_basis text not null default 'purchase';
update session_bookings set entitlement_basis = 'makeup' where makeup_entitlement_id is not null;
alter table session_bookings add constraint session_bookings_entitlement_basis_check
  check (entitlement_basis in ('purchase', 'makeup', 'package'));
alter table session_bookings add column package_entitlement_id uuid;
alter table session_bookings add column credit_disposition text;
alter table session_bookings add constraint session_bookings_credit_disposition_check
  check (credit_disposition is null or credit_disposition in ('returned', 'retained_by_policy', 'retained_pending_policy'));
alter table session_bookings add constraint session_bookings_package_entitlement_fk
  foreign key (organization_id, package_entitlement_id) references package_entitlements (organization_id, id);
-- A package booking always names its entitlement, and only a package booking does.
alter table session_bookings add constraint session_bookings_package_basis
  check ((entitlement_basis = 'package') = (package_entitlement_id is not null));
alter table session_bookings add constraint session_bookings_makeup_basis
  check ((entitlement_basis = 'makeup') = (makeup_entitlement_id is not null));
alter table session_bookings add constraint session_bookings_makeup_kind
  check (entitlement_basis <> 'makeup' or kind = 'makeup');
-- What happened to a redeemed credit is recorded when, and only when, its booking is canceled.
alter table session_bookings add constraint session_bookings_credit_disposition_fact
  check (credit_disposition is null or (status = 'canceled' and entitlement_basis = 'package'));
create index session_bookings_package_idx on session_bookings (organization_id, package_entitlement_id)
  where package_entitlement_id is not null;

-- Append-only redemption history (SPK-COND-002); a correction is a new reversal row.
create table package_redemptions (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  package_entitlement_id uuid not null,
  session_booking_id uuid not null,
  participant_person_id uuid not null,
  kind text not null check (kind in ('redeem', 'reversal')),
  reverses_redemption_id uuid,
  reason text check (reason is null or length(reason) between 1 and 2000),
  actor jsonb not null,
  redeemed_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, package_entitlement_id, session_booking_id, kind),
  foreign key (organization_id, package_entitlement_id) references package_entitlements (organization_id, id),
  foreign key (organization_id, session_booking_id) references session_bookings (organization_id, id),
  foreign key (organization_id, participant_person_id) references persons (organization_id, id),
  foreign key (organization_id, reverses_redemption_id) references package_redemptions (organization_id, id),
  check ((kind = 'reversal') = (reverses_redemption_id is not null))
);
-- One reversal per redemption.
create unique index package_redemptions_reversal_idx on package_redemptions (organization_id, reverses_redemption_id)
  where reverses_redemption_id is not null;
create index package_redemptions_entitlement_idx
  on package_redemptions (organization_id, package_entitlement_id, redeemed_at);
create trigger package_redemptions_append_only before update or delete on package_redemptions
  for each row execute function forbid_mutation();

-- Mirrors makeup_redemptions_apply (0500): the entitlement row is locked, so concurrent
-- redemptions serialize and the checks above decide; a redemption of an inactive, expired or
-- another participant's entitlement is refused; a reversal corrects exactly one redemption of the
-- same entitlement and booking.
create or replace function package_redemptions_apply() returns trigger
language plpgsql as $$
declare
  ent record;
begin
  select id, participant_person_id, status, expires_at, redeemed_count, credits
    into ent
    from package_entitlements
   where organization_id = new.organization_id and id = new.package_entitlement_id
   for update;
  if new.kind = 'redeem' then
    if ent.participant_person_id <> new.participant_person_id then
      raise exception 'package entitlement % belongs to another participant', ent.id
        using errcode = 'check_violation', constraint = 'package_entitlements_within_limit';
    end if;
    if ent.status <> 'active' or (ent.expires_at is not null and ent.expires_at <= new.redeemed_at) then
      raise exception 'package entitlement % is not redeemable (status %, expires %)', ent.id, ent.status, ent.expires_at
        using errcode = 'check_violation', constraint = 'package_entitlements_within_limit';
    end if;
    update package_entitlements
       set redeemed_count = redeemed_count + 1,
           status = case when redeemed_count + 1 >= credits then 'exhausted' else status end,
           revision = revision + 1
     where organization_id = new.organization_id and id = new.package_entitlement_id;
  else
    if not exists (
      select 1 from package_redemptions r
       where r.organization_id = new.organization_id
         and r.id = new.reverses_redemption_id
         and r.kind = 'redeem'
         and r.package_entitlement_id = new.package_entitlement_id
         and r.session_booking_id = new.session_booking_id
    ) then
      raise exception 'package reversal % must reverse a redemption of the same entitlement and booking', new.id
        using errcode = 'check_violation', constraint = 'package_entitlements_within_limit';
    end if;
    update package_entitlements
       set redeemed_count = redeemed_count - 1,
           status = case when status = 'exhausted' then 'active' else status end,
           revision = revision + 1
     where organization_id = new.organization_id and id = new.package_entitlement_id;
  end if;
  return null;
end
$$;
create trigger package_redemptions_apply after insert on package_redemptions
  for each row execute function package_redemptions_apply();
