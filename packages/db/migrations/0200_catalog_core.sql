-- 0200_catalog_core.sql
-- Catalog module (specification §3.2 SPK-CAT-001..004, §3.15 SPK-PAY-001..003 price rules and
-- discount definitions, §4.4 Catalog + Policies (PolicyVersion, Acknowledgment, Approval), §4.5
-- "Offering.priceCents must become versioned price rules and quotes", SPK-REG-002 versioned
-- eligibility policies, SPK-REG-009 "staff must not falsely sign a guardian acknowledgment",
-- SPK-YOUTH-001/002 program kinds and capacity/staffing configuration).
--
-- Invariants enforced here (CLAUDE.md "Integrity that matters is enforced in the database"):
--   * an approved policy version's content is immutable (trigger policy_versions_guard);
--   * one effective price rule per offering per instant (GiST exclusion on the effective range);
--   * a price rule's pricing content never changes (trigger price_rules_guard);
--   * a discount's redemption count can never exceed its limit (check on discount_redemptions);
--   * one active acknowledgment per (subject, policy version); a staff actor recording an
--     assisted acknowledgment is never its signer (SPK-REG-009);
--   * an offering beyond draft always carries the required configuration (SPK-CAT-004).
-- Every table carries organization scope; references use composite (organization_id, id) keys.

-- ---------------------------------------------------------------------------------------------
-- Programs: reusable definitions (SPK-CAT-001 "separate reusable program definitions")
-- ---------------------------------------------------------------------------------------------

create table programs (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  name text not null check (length(name) between 1 and 200),
  description text,
  activity_type text not null check (length(activity_type) between 1 and 100),
  format text,
  age_band jsonb not null default '{}'::jsonb,       -- { minAgeYears?, maxAgeYears? } (SPK-YOUTH-001)
  status text not null default 'draft' check (status in ('draft', 'active', 'archived')),
  created_by jsonb not null,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, name)
);
create index programs_status_idx on programs (organization_id, status, name);
create trigger programs_touch before update on programs
  for each row execute function touch_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Policy versions (§4.4 PolicyVersion, SPK-REG-002, SPK-PAY-003, §6.6 operator decisions)
-- ---------------------------------------------------------------------------------------------

create table policy_versions (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  kind text not null check (kind in (
    'eligibility', 'cancellation', 'refund', 'discount', 'waitlist', 'hold', 'approval', 'form',
    'overpayment', 'installment'
  )),
  key text not null check (key ~ '^[a-z0-9][a-z0-9_-]{0,99}$'),   -- policy family within a kind
  version integer not null check (version >= 1),
  title text not null check (length(title) between 1 and 200),
  content jsonb not null,
  effective_from timestamptz not null,
  effective_to timestamptz,
  approval_status text not null default 'draft' check (approval_status in ('draft', 'approved', 'retired')),
  approved_by jsonb,
  approved_at timestamptz,
  retired_at timestamptz,
  retired_reason text,
  created_by jsonb not null,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, kind, key, version),
  check (effective_to is null or effective_to > effective_from),
  check ((approval_status = 'draft') = (approved_at is null)),
  check ((approval_status = 'draft') = (approved_by is null)),
  check ((approval_status = 'retired') = (retired_at is not null))
);
create index policy_versions_family_idx on policy_versions (organization_id, kind, key, version desc);
create trigger policy_versions_touch before update on policy_versions
  for each row execute function touch_updated_at();

-- Approved content is a fact enrollment and finance records cite as their basis (SPK-PAY-002
-- "historical purchases retain their price and policy basis"); it can be retired, never rewritten.
create or replace function policy_versions_guard() returns trigger
language plpgsql as $$
begin
  if old.approval_status in ('approved', 'retired') then
    if new.content is distinct from old.content
       or new.kind <> old.kind
       or new.key <> old.key
       or new.version <> old.version
       or new.title <> old.title
       or new.effective_from <> old.effective_from then
      raise exception 'policy version % is immutable once approved', old.id
        using errcode = 'restrict_violation';
    end if;
    if new.approval_status = 'draft' then
      raise exception 'policy version % cannot return to draft', old.id
        using errcode = 'restrict_violation';
    end if;
  end if;
  if old.approval_status = 'retired' and new.approval_status <> 'retired' then
    raise exception 'policy version % is retired', old.id using errcode = 'restrict_violation';
  end if;
  return new;
end
$$;
create trigger policy_versions_immutable before update on policy_versions
  for each row execute function policy_versions_guard();

-- ---------------------------------------------------------------------------------------------
-- Approvals: who approved what, with reason (§4.4 Approval); append-only
-- ---------------------------------------------------------------------------------------------

create table approvals (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  subject_type text not null check (subject_type in ('policy_version', 'offering_publication')),
  subject_id uuid not null,
  decision text not null check (decision in ('approved', 'rejected')),
  actor jsonb not null,
  actor_person_id uuid,
  reason text,
  details jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, actor_person_id) references persons (organization_id, id)
);
create index approvals_subject_idx on approvals (organization_id, subject_type, subject_id, occurred_at desc);
create trigger approvals_append_only before update or delete on approvals
  for each row execute function forbid_mutation();

-- ---------------------------------------------------------------------------------------------
-- Acknowledgments (§4.4 Acknowledgment, SPK-REG-009, POL-037)
-- ---------------------------------------------------------------------------------------------

create table acknowledgments (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  subject_person_id uuid not null,                  -- the participant the policy is acknowledged for
  policy_version_id uuid not null,
  signed_by_person_id uuid not null,                -- the actual signer: the adult subject or a guardian with complete_forms
  basis text not null check (basis in ('self', 'guardian')),
  recorded_by jsonb not null,                       -- actor principal snapshot (the staff actor when assisted)
  recorded_by_kind text not null check (recorded_by_kind in ('customer', 'staff', 'system')),
  recorded_by_person_id uuid,
  signed_at timestamptz not null,
  evidence jsonb not null default '{}'::jsonb,      -- { channel, wordingVersion, ... } never child data
  status text not null default 'active' check (status in ('active', 'withdrawn')),
  withdrawn_at timestamptz,
  withdrawn_reason text,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, subject_person_id) references persons (organization_id, id),
  foreign key (organization_id, signed_by_person_id) references persons (organization_id, id),
  foreign key (organization_id, recorded_by_person_id) references persons (organization_id, id),
  foreign key (organization_id, policy_version_id) references policy_versions (organization_id, id),
  check ((status = 'withdrawn') = (withdrawn_at is not null)),
  check ((basis = 'self') = (signed_by_person_id = subject_person_id)),
  -- SPK-REG-009: the staff actor is recorded separately from the signer and is never the signer.
  constraint acknowledgments_staff_never_signer
    check (recorded_by_kind <> 'staff' or recorded_by_person_id is distinct from signed_by_person_id)
);
create unique index acknowledgments_active_idx
  on acknowledgments (organization_id, subject_person_id, policy_version_id)
  where status = 'active';
create index acknowledgments_subject_idx on acknowledgments (organization_id, subject_person_id, signed_at desc);
create trigger acknowledgments_touch before update on acknowledgments
  for each row execute function touch_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Entitlement definitions: what participation a purchase grants (§4.4 EntitlementDefinition,
-- §4.7 invariant 2 "no equivalent duplicate active entitlement where prohibited")
-- ---------------------------------------------------------------------------------------------

create table entitlement_definitions (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  name text not null check (length(name) between 1 and 200),
  description text,
  kind text not null check (kind in (
    'team_entry', 'roster_place', 'seat', 'session_seat', 'camp_group_place', 'rental_resource',
    'package_credits', 'membership_benefit'
  )),
  scope jsonb not null default '{}'::jsonb,           -- sessions included, credits, benefits …
  equivalence_scope text not null check (equivalence_scope in ('offering', 'program', 'program_period', 'session', 'none')),
  equivalence_rule jsonb not null default '{}'::jsonb,
  status text not null default 'active' check (status in ('active', 'archived')),
  created_by jsonb not null,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, name)
);
create trigger entitlement_definitions_touch before update on entitlement_definitions
  for each row execute function touch_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Offerings: dated, priced, published instances of a program (SPK-CAT-001..004)
-- ---------------------------------------------------------------------------------------------

create table offerings (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  program_id uuid not null,
  facility_id uuid not null,
  name text not null check (length(name) between 1 and 200),
  description text,
  kind text not null check (kind in (
    'season', 'term', 'camp', 'session', 'trial', 'makeup', 'pickup', 'private_coaching', 'rental',
    'package', 'membership'
  )),
  activity_type text not null,
  format text,
  location jsonb not null default '{}'::jsonb,        -- { label?, resourceIds? } (scheduling resources, no cross-module FK)
  starts_on date not null,
  ends_on date not null,
  registration_opens_at timestamptz,
  registration_closes_at timestamptz,
  eligibility_reference_date date,                    -- SPK-REG-002 configured reference date (defaults to starts_on)
  eligibility_policy_version_id uuid,
  entitlement_definition_id uuid,
  capacity_units jsonb not null default '[]'::jsonb,  -- [{ unit, limit, groupSize?, staffingRatio? }] (SPK-REG-005, SPK-YOUTH-002)
  cancellation_policy_version_id uuid,
  responsible_manager_person_id uuid,
  publication_state text not null default 'draft' check (publication_state in (
    'draft', 'published', 'registration_open', 'registration_paused', 'closed', 'archived'
  )),
  published_at timestamptz,
  registration_opened_at timestamptz,
  closed_at timestamptz,
  archived_at timestamptz,
  copied_from_offering_id uuid,
  created_by jsonb not null,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, program_id) references programs (organization_id, id),
  foreign key (organization_id, facility_id) references facilities (organization_id, id),
  foreign key (organization_id, eligibility_policy_version_id) references policy_versions (organization_id, id),
  foreign key (organization_id, entitlement_definition_id) references entitlement_definitions (organization_id, id),
  foreign key (organization_id, cancellation_policy_version_id) references policy_versions (organization_id, id),
  foreign key (organization_id, responsible_manager_person_id) references persons (organization_id, id),
  foreign key (organization_id, copied_from_offering_id) references offerings (organization_id, id),
  check (starts_on <= ends_on),
  check (registration_opens_at is null or registration_closes_at is null or registration_opens_at < registration_closes_at),
  check (publication_state in ('draft', 'archived') or published_at is not null),
  -- SPK-CAT-004: publication validates required configuration; the database refuses an offering
  -- beyond draft that lacks any of it (approval state of the policies is checked by the service).
  constraint offerings_published_configuration_complete check (
    publication_state in ('draft', 'archived') or (
      registration_opens_at is not null
      and registration_closes_at is not null
      and eligibility_policy_version_id is not null
      and entitlement_definition_id is not null
      and cancellation_policy_version_id is not null
      and responsible_manager_person_id is not null
      and jsonb_array_length(capacity_units) > 0
    )
  )
);
create index offerings_program_idx on offerings (organization_id, program_id, publication_state);
create index offerings_public_idx on offerings (organization_id, facility_id, starts_on, id)
  where publication_state in ('published', 'registration_open', 'registration_paused');
create trigger offerings_touch before update on offerings
  for each row execute function touch_updated_at();

-- Required forms (SPK-CAT-001 "required forms"): join table so each reference is a real policy version.
create table offering_required_forms (
  organization_id uuid not null references organizations(id),
  offering_id uuid not null,
  policy_version_id uuid not null,
  sequence integer not null default 1 check (sequence >= 1),
  primary key (organization_id, offering_id, policy_version_id),
  foreign key (organization_id, offering_id) references offerings (organization_id, id) on delete cascade,
  foreign key (organization_id, policy_version_id) references policy_versions (organization_id, id)
);

-- Individual sessions of an offering (§4.4 Session, SPK-CAT-002). The scheduling event that
-- reserves space is referenced by id only: migration order and §4.2 forbid a cross-module FK.
create table offering_sessions (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  offering_id uuid not null,
  sequence integer not null check (sequence >= 1),
  title text,
  scheduled_start timestamptz not null,
  scheduled_end timestamptz not null,
  scheduling_event_id uuid,
  capacity_override jsonb,                            -- same shape as offerings.capacity_units, or null
  status text not null default 'scheduled' check (status in ('scheduled', 'canceled', 'completed')),
  canceled_at timestamptz,
  cancel_reason text,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, offering_id, sequence),
  foreign key (organization_id, offering_id) references offerings (organization_id, id),
  check (scheduled_start < scheduled_end),
  check ((status = 'canceled') = (canceled_at is not null))
);
create index offering_sessions_offering_idx on offering_sessions (organization_id, offering_id, scheduled_start);
create trigger offering_sessions_touch before update on offering_sessions
  for each row execute function touch_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Price rules: versioned prices per offering (SPK-PAY-001/002, §4.5)
-- ---------------------------------------------------------------------------------------------

create table price_rules (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  offering_id uuid not null,
  version integer not null check (version >= 1),
  effective_from timestamptz not null,
  effective_to timestamptz,
  base_price_minor bigint not null check (base_price_minor >= 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  charge_lines jsonb not null default '[]'::jsonb,    -- approved taxes and fees: [{ code, label, kind, basisPoints|amountMinor, inclusive }]
  created_by jsonb not null,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, offering_id, version),
  foreign key (organization_id, offering_id) references offerings (organization_id, id),
  check (effective_to is null or effective_to > effective_from),
  -- one effective price rule per offering per instant (half-open ranges)
  constraint price_rules_one_effective_per_instant
    exclude using gist (
      organization_id with =,
      offering_id with =,
      tstzrange(effective_from, effective_to, '[)') with &&
    )
);
create index price_rules_offering_idx on price_rules (organization_id, offering_id, effective_from desc);
create trigger price_rules_touch before update on price_rules
  for each row execute function touch_updated_at();

-- Pricing content is immutable: a correction is a new version. The only permitted change is
-- closing the effective window (effective_to), which the service refuses to place in the past.
create or replace function price_rules_guard() returns trigger
language plpgsql as $$
begin
  if new.offering_id <> old.offering_id
     or new.version <> old.version
     or new.effective_from <> old.effective_from
     or new.base_price_minor <> old.base_price_minor
     or new.currency <> old.currency
     or new.charge_lines is distinct from old.charge_lines then
    raise exception 'price rule % is immutable; create a new version', old.id
      using errcode = 'restrict_violation';
  end if;
  if old.effective_to is not null and new.effective_to is distinct from old.effective_to
     and (new.effective_to is null or new.effective_to > old.effective_to) then
    raise exception 'price rule % cannot be extended; create a new version', old.id
      using errcode = 'restrict_violation';
  end if;
  return new;
end
$$;
create trigger price_rules_immutable before update on price_rules
  for each row execute function price_rules_guard();

-- ---------------------------------------------------------------------------------------------
-- Discount definitions and redemptions (SPK-PAY-003, §4.7 invariant 7)
-- ---------------------------------------------------------------------------------------------

create table discount_definitions (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  code text,                                          -- promo code, case-insensitive unique; null = automatic
  name text not null check (length(name) between 1 and 200),
  description text,
  kind text not null check (kind in ('promo_code', 'automatic')),
  amount_kind text not null check (amount_kind in ('percentage', 'fixed')),
  amount_value bigint not null check (amount_value > 0), -- basis points (percentage) or minor units (fixed)
  currency text check (currency is null or currency ~ '^[A-Z]{3}$'),
  eligibility_rules jsonb not null default '{}'::jsonb,
  stacking_rule text not null default 'exclusive' check (stacking_rule in ('exclusive', 'stackable')),
  stacking_priority integer not null default 100,
  cap_minor bigint check (cap_minor is null or cap_minor >= 0),
  redemption_limit integer check (redemption_limit is null or redemption_limit >= 0),
  per_person_limit integer check (per_person_limit is null or per_person_limit >= 1),
  rounding text not null default 'half_up' check (rounding in ('half_up', 'half_even', 'down', 'up')),
  allocation_method text not null default 'proportional' check (allocation_method in ('proportional', 'largest_first', 'first_line', 'even')),
  effective_from timestamptz not null,
  effective_to timestamptz,
  status text not null default 'draft' check (status in ('draft', 'active', 'retired')),
  created_by jsonb not null,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  check ((kind = 'promo_code') = (code is not null)),
  check (code is null or code ~ '^[A-Za-z0-9][A-Za-z0-9_-]{1,49}$'),
  check (amount_kind <> 'percentage' or amount_value <= 10000),
  check (amount_kind <> 'fixed' or currency is not null),
  check (effective_to is null or effective_to > effective_from)
);
create unique index discount_definitions_code_idx on discount_definitions (organization_id, lower(code))
  where code is not null;
create index discount_definitions_status_idx on discount_definitions (organization_id, status, effective_from);
create trigger discount_definitions_touch before update on discount_definitions
  for each row execute function touch_updated_at();

-- Redemption counter. The limit is mirrored here so the database itself refuses the redemption
-- that would exceed it (§4.7 invariant 7), independently of the conditional update the service runs.
create table discount_redemptions (
  organization_id uuid not null references organizations(id),
  discount_definition_id uuid not null,
  redemption_limit integer check (redemption_limit is null or redemption_limit >= 0),
  redeemed_count integer not null default 0 check (redeemed_count >= 0),
  updated_at timestamptz not null default now(),
  primary key (organization_id, discount_definition_id),
  foreign key (organization_id, discount_definition_id) references discount_definitions (organization_id, id),
  constraint discount_redemptions_within_limit
    check (redemption_limit is null or redeemed_count <= redemption_limit)
);
create trigger discount_redemptions_touch before update on discount_redemptions
  for each row execute function touch_updated_at();

-- Append-only redemption history: one redeem and at most one release per referencing record
-- (order line, enrollment …) so a replayed checkout never redeems twice (§4.7 invariant 5).
create table discount_redemption_entries (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  discount_definition_id uuid not null,
  kind text not null check (kind in ('redeem', 'release')),
  reference_type text not null check (length(reference_type) between 1 and 100),
  reference_id uuid not null,
  person_id uuid,
  amount_minor bigint check (amount_minor is null or amount_minor >= 0),
  currency text check (currency is null or currency ~ '^[A-Z]{3}$'),
  actor jsonb not null,
  occurred_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (organization_id, discount_definition_id, reference_type, reference_id, kind),
  foreign key (organization_id, discount_definition_id) references discount_definitions (organization_id, id),
  foreign key (organization_id, person_id) references persons (organization_id, id)
);
create index discount_redemption_entries_person_idx
  on discount_redemption_entries (organization_id, discount_definition_id, person_id)
  where person_id is not null;
create trigger discount_redemption_entries_append_only before update or delete on discount_redemption_entries
  for each row execute function forbid_mutation();
