-- 0500_enrollment_core.sql
-- Enrollment module (specification §3.3 SPK-REG-001..010, §3.6 SPK-PLACE-001..005, §3.13
-- SPK-YOUTH-001..007, §4.4 Participation (Application, Enrollment, PlacementRequest,
-- SessionBooking) and Capacity (CapacityPool, Hold, Allocation, WaitlistEntry, WaitlistOffer),
-- §4.6 Application/Enrollment/Placement/Hold/SessionBooking machines, §4.7 invariants 2, 3, 7,
-- SPK-AT-004/005/006/019/020).
--
-- Invariants enforced here (CLAUDE.md "Integrity that matters is enforced in the database"):
--   * §4.7 (2): no equivalent duplicate active entitlement — partial unique index on
--     (organization, participant, equivalence_key) over pending/confirmed enrollments
--     (enrollments_equivalent_active_idx, SPK-AT-004);
--   * §4.7 (3): no overcommitted capacity — check (committed + held <= capacity) on every pool;
--     the service acquires with a conditional UPDATE and several pools per offering are several
--     simultaneous constraints acquired in id order (SPK-REG-005, SPK-AT-005);
--   * SPK-REG-006: a hold has exactly one terminal outcome — the status and its fact agree;
--   * SPK-REG-008: one open offer per waitlist entry; acceptance consumes it once;
--   * §4.7 (7), SPK-AT-020: a makeup entitlement can never be redeemed beyond its limit —
--     check (redeemed_count <= redemption_limit); redemptions are append-only;
--   * SPK-PLACE-004: pickup bookings are session bookings with their own capacity; nothing here
--     references a roster row, so pickup attendance can never create league membership;
--   * SPK-REG-009: the staff actor of an assisted registration is a separate column from the
--     participant, payer and signer (signers live in catalog acknowledgments, never here).
-- Every table carries organization scope; references use composite (organization_id, id) keys,
-- including references into identity (persons), catalog (offerings, offering_sessions,
-- entitlement_definitions, policy_versions) and competition (team_entries, divisions, seasons),
-- all of which migrate earlier.

-- ---------------------------------------------------------------------------------------------
-- Capacity pools (§4.4 CapacityPool, SPK-REG-005, SPK-YOUTH-002)
-- ---------------------------------------------------------------------------------------------

create table capacity_pools (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  offering_id uuid,                                   -- the offering the pool constrains (null for a bare team entry or rental pool)
  scope_type text not null check (scope_type in ('offering', 'session', 'division', 'team_entry', 'camp_group', 'rental')),
  scope_id uuid not null,
  unit text not null check (unit in ('team_entries', 'roster_places', 'seats', 'session_seats', 'camp_group_places', 'rental_resources')),
  -- Several pools per offering are several simultaneous constraints (SPK-REG-005): the commercial
  -- limit, the staffing limit derived from the staffing ratio (SPK-YOUTH-002) and a space limit.
  constraint_kind text not null default 'commercial' check (constraint_kind in ('commercial', 'staffing', 'space')),
  capacity integer not null check (capacity >= 0),
  committed integer not null default 0,
  held integer not null default 0,
  -- SPK-YOUTH-002: the staffing pool remembers the ratio and the staff count it was sized from.
  participants_per_staff integer check (participants_per_staff is null or participants_per_staff >= 1),
  staff_count integer check (staff_count is null or staff_count >= 0),
  status text not null default 'active' check (status in ('active', 'closed')),
  created_by jsonb not null,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, scope_type, scope_id, unit, constraint_kind),
  foreign key (organization_id, offering_id) references offerings (organization_id, id),
  constraint capacity_pools_non_negative check (committed >= 0 and held >= 0),
  -- §4.7 invariant 3: active holds and accepted commitments never exceed the capacity.
  constraint capacity_pools_within_capacity check (committed + held <= capacity),
  constraint capacity_pools_staffing_shape check (
    constraint_kind <> 'staffing' or (participants_per_staff is not null and staff_count is not null)
  )
);
create index capacity_pools_offering_idx on capacity_pools (organization_id, offering_id) where offering_id is not null;
create trigger capacity_pools_touch before update on capacity_pools
  for each row execute function touch_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Baskets (SPK-REG-004 household basket, SPK-REG-009 assisted registration)
-- ---------------------------------------------------------------------------------------------

create table baskets (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  owner_person_id uuid not null,                      -- the household adult the basket belongs to
  payer_person_id uuid,                               -- named payer (defaults to the owner); recorded separately from the staff actor
  created_by jsonb not null,                          -- actor snapshot: the staff actor when assisted (SPK-REG-009)
  created_by_person_id uuid,
  assisted_by_person_id uuid,                         -- staff person who assisted, never the participant, payer or signer
  fulfillment_mode text not null default 'all_or_nothing' check (fulfillment_mode in ('all_or_nothing', 'partial')),
  partial_accepted_at timestamptz,                    -- SPK-REG-004: partial fulfillment needs the customer's explicit acceptance
  status text not null default 'open' check (status in (
    'open', 'held', 'checking_out', 'fulfilled', 'partially_fulfilled', 'expired', 'released', 'abandoned'
  )),
  hold_expires_at timestamptz,
  currency text check (currency is null or currency ~ '^[A-Z]{3}$'),
  order_ref text,                                     -- finance order id (string, no cross-module key)
  last_operation_id uuid,                             -- durable operation of the latest multi-step command (§4.8)
  checkout_started_at timestamptz,
  fulfilled_at timestamptz,
  released_at timestamptz,
  release_reason text,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, owner_person_id) references persons (organization_id, id),
  foreign key (organization_id, payer_person_id) references persons (organization_id, id),
  foreign key (organization_id, created_by_person_id) references persons (organization_id, id),
  foreign key (organization_id, assisted_by_person_id) references persons (organization_id, id),
  check (fulfillment_mode <> 'partial' or partial_accepted_at is not null),
  check (status not in ('held', 'checking_out') or hold_expires_at is not null)
);
create index baskets_owner_idx on baskets (organization_id, owner_person_id, created_at desc);
create index baskets_status_idx on baskets (organization_id, status) where status in ('held', 'checking_out');
create trigger baskets_touch before update on baskets
  for each row execute function touch_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Applications (§4.4 Application, SPK-REG-001..003, SPK-REG-007; ApplicationMachine §4.6)
-- ---------------------------------------------------------------------------------------------

create table applications (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  offering_id uuid not null,
  participant_person_id uuid not null,
  intent text not null check (intent in (
    'individual_league', 'join_team', 'create_team_entry', 'youth', 'trial', 'makeup', 'pickup', 'rental_request'
  )),
  submitted_by jsonb not null,                        -- actor snapshot (staff actor when assisted, SPK-REG-009)
  submitted_by_person_id uuid,
  payer_person_id uuid,
  status text not null default 'draft' check (status in (
    'draft', 'submitted', 'awaiting_review', 'accepted', 'declined', 'withdrawn'
  )),
  -- SPK-REG-002: { policyVersionId, referenceDate, eligible, reasons[], alternatives[], evaluatedAt }
  eligibility_result jsonb not null default '{}'::jsonb,
  -- SPK-REG-002 override: { actor, actorPersonId, reason, overriddenAt, originalEligible }
  override jsonb,
  requires_approval boolean not null default false,  -- SPK-REG-007 (DEC-028)
  team_entry_id uuid,                                 -- join_team intent: the entry applied to
  session_id uuid,                                    -- session-scoped intents (trial, makeup, pickup)
  notes text,
  submitted_at timestamptz,
  decided_at timestamptz,
  decided_by jsonb,
  decided_by_person_id uuid,
  decision_reason text,
  withdrawn_at timestamptz,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, offering_id) references offerings (organization_id, id),
  foreign key (organization_id, participant_person_id) references persons (organization_id, id),
  foreign key (organization_id, submitted_by_person_id) references persons (organization_id, id),
  foreign key (organization_id, payer_person_id) references persons (organization_id, id),
  foreign key (organization_id, decided_by_person_id) references persons (organization_id, id),
  foreign key (organization_id, team_entry_id) references team_entries (organization_id, id),
  foreign key (organization_id, session_id) references offering_sessions (organization_id, id),
  check (status = 'draft' or submitted_at is not null),
  check ((status in ('accepted', 'declined')) = (decided_at is not null)),
  check ((status = 'withdrawn') = (withdrawn_at is not null))
);
-- One open application per participant and offering: a second guardian cannot open a parallel one (SPK-AT-004).
create unique index applications_open_idx on applications (organization_id, offering_id, participant_person_id)
  where status in ('submitted', 'awaiting_review');
create index applications_review_idx on applications (organization_id, offering_id, status, submitted_at);
create index applications_participant_idx on applications (organization_id, participant_person_id, created_at desc);
create trigger applications_touch before update on applications
  for each row execute function touch_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Holds (§4.4 Hold, SPK-REG-006; HoldMachine §4.6)
-- ---------------------------------------------------------------------------------------------

create table holds (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  pool_id uuid not null,
  quantity integer not null check (quantity >= 1),
  owner_kind text not null check (owner_kind in ('basket', 'waitlist_offer', 'session_booking', 'placement', 'staff')),
  owner_id uuid,
  basket_id uuid,
  actor jsonb not null,
  status text not null default 'active' check (status in ('active', 'committed', 'released', 'expired')),
  acquired_at timestamptz not null,
  expires_at timestamptz not null,                    -- server-owned expiry (SPK-REG-006)
  committed_at timestamptz,
  released_at timestamptz,
  expired_at timestamptz,
  release_reason text,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, pool_id) references capacity_pools (organization_id, id),
  foreign key (organization_id, basket_id) references baskets (organization_id, id),
  check (expires_at > acquired_at),
  -- Exactly one terminal outcome: the status names it and exactly its fact is present.
  constraint holds_one_terminal_outcome check (
    (status = 'active' and committed_at is null and released_at is null and expired_at is null)
    or (status = 'committed' and committed_at is not null and released_at is null and expired_at is null)
    or (status = 'released' and released_at is not null and committed_at is null and expired_at is null)
    or (status = 'expired' and expired_at is not null and committed_at is null and released_at is null)
  )
);
create index holds_pool_active_idx on holds (organization_id, pool_id) where status = 'active';
create index holds_basket_idx on holds (organization_id, basket_id) where basket_id is not null;
create index holds_owner_idx on holds (organization_id, owner_kind, owner_id) where owner_id is not null;
create trigger holds_touch before update on holds
  for each row execute function touch_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Enrollments (§4.4 Enrollment, SPK-REG-003/004/010, §4.7 invariant 2; EnrollmentMachine §4.6)
-- ---------------------------------------------------------------------------------------------

create table enrollments (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  offering_id uuid not null,
  participant_person_id uuid not null,
  intent text not null check (intent in (
    'individual_league', 'join_team', 'create_team_entry', 'youth', 'trial', 'makeup', 'pickup', 'rental_request'
  )),
  entitlement_definition_id uuid,
  equivalence_key text,                               -- catalog equivalenceKey(); null = duplicates permitted
  status text not null default 'pending' check (status in ('pending', 'confirmed', 'canceled', 'transferred', 'completed')),
  payer_person_id uuid,
  registered_by jsonb not null,                       -- actor snapshot; the staff actor when assisted (SPK-REG-009)
  registered_by_person_id uuid,
  assisted_by_person_id uuid,
  source_application_id uuid,
  basket_id uuid,
  basket_line_id uuid,                                -- added below (basket_lines is created after)
  placement_request_id uuid,                          -- added below
  trial_participation_id uuid,                        -- added below (SPK-AT-019 conversion link)
  order_ref text,                                     -- finance order id (string)
  last_operation_id uuid,
  price_snapshot jsonb,                               -- { priceRuleId, basePriceMinor, currency, chargeLines } at registration
  policy_references jsonb not null default '{}'::jsonb, -- { eligibilityPolicyVersionId, cancellationPolicyVersionId, requiredFormPolicyVersionIds[], ... }
  eligibility_result jsonb not null default '{}'::jsonb,
  confirmed_at timestamptz,
  canceled_at timestamptz,
  cancellation_reason text,
  cancellation_policy_version_id uuid,
  cancellation_consequence jsonb,                     -- FinancePolicyPort outcome recorded as a fact
  transferred_at timestamptz,
  transferred_to_enrollment_id uuid,
  transferred_from_enrollment_id uuid,
  completed_at timestamptz,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, offering_id) references offerings (organization_id, id),
  foreign key (organization_id, participant_person_id) references persons (organization_id, id),
  foreign key (organization_id, entitlement_definition_id) references entitlement_definitions (organization_id, id),
  foreign key (organization_id, payer_person_id) references persons (organization_id, id),
  foreign key (organization_id, registered_by_person_id) references persons (organization_id, id),
  foreign key (organization_id, assisted_by_person_id) references persons (organization_id, id),
  foreign key (organization_id, source_application_id) references applications (organization_id, id),
  foreign key (organization_id, basket_id) references baskets (organization_id, id),
  foreign key (organization_id, cancellation_policy_version_id) references policy_versions (organization_id, id),
  foreign key (organization_id, transferred_to_enrollment_id) references enrollments (organization_id, id),
  foreign key (organization_id, transferred_from_enrollment_id) references enrollments (organization_id, id),
  check (transferred_to_enrollment_id is null or transferred_to_enrollment_id <> id),
  check (transferred_from_enrollment_id is null or transferred_from_enrollment_id <> id),
  constraint enrollments_confirmation_fact check (status not in ('confirmed', 'transferred', 'completed') or confirmed_at is not null),
  constraint enrollments_cancellation_fact check ((status = 'canceled') = (canceled_at is not null)),
  constraint enrollments_transfer_fact check ((status = 'transferred') = (transferred_at is not null and transferred_to_enrollment_id is not null)),
  constraint enrollments_completion_fact check ((status = 'completed') = (completed_at is not null))
);
-- §4.7 invariant 2 (SPK-AT-004): one equivalent active entitlement per participant, whoever registers.
create unique index enrollments_equivalent_active_idx
  on enrollments (organization_id, participant_person_id, equivalence_key)
  where status in ('pending', 'confirmed') and equivalence_key is not null;
create index enrollments_offering_idx on enrollments (organization_id, offering_id, status);
create index enrollments_participant_idx on enrollments (organization_id, participant_person_id, status);
create index enrollments_basket_idx on enrollments (organization_id, basket_id) where basket_id is not null;
create trigger enrollments_touch before update on enrollments
  for each row execute function touch_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Basket lines (SPK-REG-004: each line keeps its participant, entitlement, eligibility, price,
-- policy and enrollment outcome)
-- ---------------------------------------------------------------------------------------------

create table basket_lines (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  basket_id uuid not null,
  sequence integer not null check (sequence >= 1),
  participant_person_id uuid not null,
  offering_id uuid not null,
  session_id uuid,
  team_entry_id uuid,
  intent text not null check (intent in (
    'individual_league', 'join_team', 'create_team_entry', 'youth', 'trial', 'makeup', 'pickup', 'rental_request'
  )),
  quantity integer not null default 1 check (quantity >= 1),
  application_id uuid,
  trial_participation_id uuid,                        -- SPK-AT-019: a follow-up line opened from a trial (FK added below)
  entitlement_definition_id uuid,
  equivalence_key text,
  eligibility_result jsonb not null default '{}'::jsonb,
  price_snapshot jsonb,                               -- from the catalog PricingPort at the time the line was added
  policy_references jsonb not null default '{}'::jsonb,
  requires_approval boolean not null default false,
  enrollment_id uuid,
  outcome text not null default 'pending' check (outcome in ('pending', 'held', 'confirmed', 'failed', 'released')),
  outcome_reason text,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, basket_id, sequence),
  -- one line per participant and offering (and session) in a basket
  unique (organization_id, basket_id, participant_person_id, offering_id, session_id),
  foreign key (organization_id, basket_id) references baskets (organization_id, id),
  foreign key (organization_id, participant_person_id) references persons (organization_id, id),
  foreign key (organization_id, offering_id) references offerings (organization_id, id),
  foreign key (organization_id, session_id) references offering_sessions (organization_id, id),
  foreign key (organization_id, team_entry_id) references team_entries (organization_id, id),
  foreign key (organization_id, application_id) references applications (organization_id, id),
  foreign key (organization_id, entitlement_definition_id) references entitlement_definitions (organization_id, id),
  foreign key (organization_id, enrollment_id) references enrollments (organization_id, id)
);
create index basket_lines_basket_idx on basket_lines (organization_id, basket_id, sequence);
create trigger basket_lines_touch before update on basket_lines
  for each row execute function touch_updated_at();

alter table enrollments
  add foreign key (organization_id, basket_line_id) references basket_lines (organization_id, id);

-- ---------------------------------------------------------------------------------------------
-- Placement requests (§4.4 PlacementRequest, SPK-PLACE-001..003/005; PlacementMachine §4.6)
-- ---------------------------------------------------------------------------------------------

create table placement_requests (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  participant_person_id uuid not null,
  application_id uuid,
  enrollment_id uuid,
  offering_id uuid,
  season_id uuid not null,                            -- competition season the free agent wants to play in
  status text not null default 'unassigned' check (status in ('unassigned', 'proposed', 'assigned', 'released')),
  availability jsonb not null default '[]'::jsonb,    -- [{ weekday, from, to }] or free text windows
  preferred_competition_id uuid,
  preferred_division_id uuid,
  declared_level text,
  position_preferences jsonb not null default '[]'::jsonb,
  requested_teammate_person_ids jsonb not null default '[]'::jsonb,
  notes text,
  requested_by jsonb not null,
  requested_by_person_id uuid,
  proposed_team_entry_id uuid,
  proposed_at timestamptz,
  proposed_by jsonb,
  proposal_reasons jsonb not null default '[]'::jsonb, -- explainable reasons for the proposal (SPK-PLACE-002)
  assigned_team_entry_id uuid,
  assigned_at timestamptz,
  decided_by jsonb,
  decided_by_person_id uuid,
  decision_reasons jsonb not null default '[]'::jsonb, -- eligibility + capacity facts at commitment (SPK-PLACE-003)
  roster_membership_ref uuid,                         -- competition roster row created through its service (no FK, §4.2)
  last_operation_id uuid,
  released_at timestamptz,
  release_reason text,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, participant_person_id) references persons (organization_id, id),
  foreign key (organization_id, application_id) references applications (organization_id, id),
  foreign key (organization_id, enrollment_id) references enrollments (organization_id, id),
  foreign key (organization_id, offering_id) references offerings (organization_id, id),
  foreign key (organization_id, season_id) references seasons (organization_id, id),
  foreign key (organization_id, preferred_division_id) references divisions (organization_id, id),
  foreign key (organization_id, requested_by_person_id) references persons (organization_id, id),
  foreign key (organization_id, proposed_team_entry_id) references team_entries (organization_id, id),
  foreign key (organization_id, assigned_team_entry_id) references team_entries (organization_id, id),
  foreign key (organization_id, decided_by_person_id) references persons (organization_id, id),
  constraint placement_requests_proposal_fact check (status <> 'proposed' or (proposed_team_entry_id is not null and proposed_at is not null)),
  constraint placement_requests_assignment_fact check (status not in ('assigned', 'released') or (assigned_team_entry_id is not null and assigned_at is not null)),
  constraint placement_requests_release_fact check ((status = 'released') = (released_at is not null))
);
-- One live placement request per participant and season.
create unique index placement_requests_live_idx on placement_requests (organization_id, season_id, participant_person_id)
  where status in ('unassigned', 'proposed', 'assigned');
create index placement_requests_season_idx on placement_requests (organization_id, season_id, status);
create trigger placement_requests_touch before update on placement_requests
  for each row execute function touch_updated_at();

alter table enrollments
  add foreign key (organization_id, placement_request_id) references placement_requests (organization_id, id);

-- ---------------------------------------------------------------------------------------------
-- Makeup entitlements (SPK-YOUTH-004, SPK-AT-020, §4.7 invariant 7). A monetary credit is a
-- different asset owned by finance: no money columns exist here.
-- ---------------------------------------------------------------------------------------------

create table makeup_entitlements (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  participant_person_id uuid not null,
  originating_enrollment_id uuid,
  originating_session_id uuid,
  origin_kind text not null check (origin_kind in ('session_canceled', 'absence', 'policy_event', 'manual')),
  origin_reference text,                              -- e.g. the policy event or closure reference
  eligible_offering_ids jsonb not null default '[]'::jsonb,   -- eligible replacements: offerings …
  eligible_program_ids jsonb not null default '[]'::jsonb,    -- … or programs (any session of them)
  issued_by jsonb not null,
  issued_by_person_id uuid,
  reason text not null,
  expires_at timestamptz not null,
  redemption_limit integer not null default 1 check (redemption_limit >= 1),
  redeemed_count integer not null default 0 check (redeemed_count >= 0),
  status text not null default 'active' check (status in ('active', 'exhausted', 'expired', 'revoked')),
  revoked_at timestamptz,
  revoked_reason text,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, participant_person_id) references persons (organization_id, id),
  foreign key (organization_id, originating_enrollment_id) references enrollments (organization_id, id),
  foreign key (organization_id, originating_session_id) references offering_sessions (organization_id, id),
  foreign key (organization_id, issued_by_person_id) references persons (organization_id, id),
  -- SPK-AT-020: the database refuses the redemption that would exceed the limit.
  constraint makeup_entitlements_within_limit check (redeemed_count <= redemption_limit),
  constraint makeup_entitlements_exhausted_fact check (status <> 'exhausted' or redeemed_count = redemption_limit),
  constraint makeup_entitlements_active_has_room check (status <> 'active' or redeemed_count < redemption_limit),
  check ((status = 'revoked') = (revoked_at is not null))
);
create index makeup_entitlements_participant_idx on makeup_entitlements (organization_id, participant_person_id, status);
create trigger makeup_entitlements_touch before update on makeup_entitlements
  for each row execute function touch_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Session bookings (§4.4 SessionBooking, SPK-PLACE-004 pickup, SPK-YOUTH-003 trials,
-- SPK-YOUTH-004 makeups; SessionBookingMachine §4.6)
-- ---------------------------------------------------------------------------------------------

create table session_bookings (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  offering_id uuid not null,
  session_id uuid not null,
  participant_person_id uuid not null,
  kind text not null check (kind in ('pickup', 'trial', 'makeup', 'session')),
  status text not null default 'pending' check (status in ('pending', 'confirmed', 'canceled', 'expired')),
  pool_id uuid,
  hold_id uuid,
  makeup_entitlement_id uuid,
  scheduled_start timestamptz not null,               -- copied from the catalog session for the family calendar (SPK-YOUTH-007)
  scheduled_end timestamptz not null,
  booked_by jsonb not null,
  booked_by_person_id uuid,
  assisted_by_person_id uuid,
  payer_person_id uuid,
  price_snapshot jsonb,
  policy_references jsonb not null default '{}'::jsonb,
  eligibility_result jsonb not null default '{}'::jsonb,
  expires_at timestamptz,
  confirmed_at timestamptz,
  canceled_at timestamptz,
  cancel_reason text,
  expired_at timestamptz,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, offering_id) references offerings (organization_id, id),
  foreign key (organization_id, session_id) references offering_sessions (organization_id, id),
  foreign key (organization_id, participant_person_id) references persons (organization_id, id),
  foreign key (organization_id, pool_id) references capacity_pools (organization_id, id),
  foreign key (organization_id, hold_id) references holds (organization_id, id),
  foreign key (organization_id, makeup_entitlement_id) references makeup_entitlements (organization_id, id),
  foreign key (organization_id, booked_by_person_id) references persons (organization_id, id),
  foreign key (organization_id, assisted_by_person_id) references persons (organization_id, id),
  foreign key (organization_id, payer_person_id) references persons (organization_id, id),
  check (scheduled_start < scheduled_end),
  -- a canceled booking keeps the instant it had been confirmed (history), so confirmation is one-way
  constraint session_bookings_confirmation_fact check (status <> 'confirmed' or confirmed_at is not null),
  constraint session_bookings_cancellation_fact check ((status = 'canceled') = (canceled_at is not null)),
  constraint session_bookings_expiry_fact check ((status = 'expired') = (expired_at is not null and confirmed_at is null))
);
-- One live booking per participant and session (pickup or otherwise).
create unique index session_bookings_live_idx on session_bookings (organization_id, session_id, participant_person_id)
  where status in ('pending', 'confirmed');
create index session_bookings_participant_idx on session_bookings (organization_id, participant_person_id, scheduled_start);
create index session_bookings_session_idx on session_bookings (organization_id, session_id, status);
create trigger session_bookings_touch before update on session_bookings
  for each row execute function touch_updated_at();

-- Append-only redemption history (SPK-YOUTH-004 "redemption history"); a correction is a new
-- row referencing what it reverses, never an update.
create table makeup_redemptions (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  makeup_entitlement_id uuid not null,
  session_booking_id uuid not null,
  participant_person_id uuid not null,
  kind text not null default 'redeem' check (kind in ('redeem', 'reversal')),
  reverses_redemption_id uuid,
  actor jsonb not null,
  redeemed_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (organization_id, id),
  -- one redemption per booking: a replayed command cannot consume twice
  unique (organization_id, makeup_entitlement_id, session_booking_id, kind),
  foreign key (organization_id, makeup_entitlement_id) references makeup_entitlements (organization_id, id),
  foreign key (organization_id, session_booking_id) references session_bookings (organization_id, id),
  foreign key (organization_id, participant_person_id) references persons (organization_id, id),
  foreign key (organization_id, reverses_redemption_id) references makeup_redemptions (organization_id, id),
  check ((kind = 'reversal') = (reverses_redemption_id is not null))
);
create unique index makeup_redemptions_reversal_idx on makeup_redemptions (organization_id, reverses_redemption_id)
  where reverses_redemption_id is not null;
create index makeup_redemptions_entitlement_idx on makeup_redemptions (organization_id, makeup_entitlement_id, redeemed_at);
create trigger makeup_redemptions_append_only before update or delete on makeup_redemptions
  for each row execute function forbid_mutation();

-- ---------------------------------------------------------------------------------------------
-- Allocations (§4.4 Allocation): committed capacity attached to an enrollment, booking or placement
-- ---------------------------------------------------------------------------------------------

create table allocations (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  pool_id uuid not null,
  hold_id uuid,
  enrollment_id uuid,
  session_booking_id uuid,
  placement_request_id uuid,
  quantity integer not null check (quantity >= 1),
  status text not null default 'active' check (status in ('active', 'released')),
  allocated_at timestamptz not null,
  released_at timestamptz,
  release_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, pool_id) references capacity_pools (organization_id, id),
  foreign key (organization_id, hold_id) references holds (organization_id, id),
  foreign key (organization_id, enrollment_id) references enrollments (organization_id, id),
  foreign key (organization_id, session_booking_id) references session_bookings (organization_id, id),
  foreign key (organization_id, placement_request_id) references placement_requests (organization_id, id),
  check (enrollment_id is not null or session_booking_id is not null or placement_request_id is not null),
  check ((status = 'released') = (released_at is not null))
);
-- a hold converts to at most one allocation (commitHolds is atomic and replay-safe)
create unique index allocations_hold_idx on allocations (organization_id, hold_id) where hold_id is not null;
create index allocations_pool_idx on allocations (organization_id, pool_id) where status = 'active';
create index allocations_enrollment_idx on allocations (organization_id, enrollment_id) where enrollment_id is not null;
create trigger allocations_touch before update on allocations
  for each row execute function touch_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Waitlists (§4.4 WaitlistEntry, WaitlistOffer; SPK-REG-008, SPK-AT-006)
-- ---------------------------------------------------------------------------------------------

create table waitlist_entries (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  offering_id uuid not null,
  pool_id uuid not null,                              -- the primary pool the entry waits for (offering or session seats)
  session_id uuid,                                    -- session waitlists (pickup, trial, makeup seats, SPK-PLACE-004)
  participant_person_id uuid not null,
  intent text not null check (intent in (
    'individual_league', 'join_team', 'create_team_entry', 'youth', 'trial', 'makeup', 'pickup', 'rental_request'
  )),
  priority_basis text not null default 'joined_at' check (priority_basis in ('joined_at', 'priority_tier', 'returning', 'manual')),
  priority_rank integer not null default 100,         -- lower ranks are offered first; ties by joined_at
  joined_at timestamptz not null,                     -- fact: when the participant joined
  queued_at timestamptz not null,                     -- queue order within a rank; an expired offer may requeue (DEC-006)
  preferences jsonb not null default '{}'::jsonb,
  requested_by jsonb not null,
  requested_by_person_id uuid,
  payer_person_id uuid,
  status text not null default 'waiting' check (status in ('waiting', 'offered', 'accepted', 'expired', 'withdrawn', 'removed')),
  offer_count integer not null default 0 check (offer_count >= 0),
  accepted_enrollment_id uuid,
  withdrawn_at timestamptz,
  removed_at timestamptz,
  removal_reason text,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, offering_id) references offerings (organization_id, id),
  foreign key (organization_id, pool_id) references capacity_pools (organization_id, id),
  foreign key (organization_id, session_id) references offering_sessions (organization_id, id),
  foreign key (organization_id, participant_person_id) references persons (organization_id, id),
  foreign key (organization_id, requested_by_person_id) references persons (organization_id, id),
  foreign key (organization_id, payer_person_id) references persons (organization_id, id),
  foreign key (organization_id, accepted_enrollment_id) references enrollments (organization_id, id),
  check ((status = 'withdrawn') = (withdrawn_at is not null)),
  check ((status = 'removed') = (removed_at is not null))
);
create unique index waitlist_entries_live_idx on waitlist_entries (organization_id, pool_id, participant_person_id)
  where status in ('waiting', 'offered');
create index waitlist_entries_queue_idx on waitlist_entries (organization_id, offering_id, priority_rank, queued_at)
  where status = 'waiting';
create trigger waitlist_entries_touch before update on waitlist_entries
  for each row execute function touch_updated_at();

create table waitlist_offers (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  waitlist_entry_id uuid not null,
  pool_id uuid not null,
  hold_id uuid not null,                              -- the offer reserves a defined place through a hold
  quantity integer not null check (quantity >= 1),
  offered_at timestamptz not null,
  expires_at timestamptz not null,
  status text not null default 'offered' check (status in ('offered', 'accepted', 'expired', 'declined')),
  accepted_at timestamptz,
  accepted_basket_id uuid,
  accepted_enrollment_id uuid,
  accepted_session_booking_id uuid,
  declined_at timestamptz,
  expired_at timestamptz,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, waitlist_entry_id) references waitlist_entries (organization_id, id),
  foreign key (organization_id, pool_id) references capacity_pools (organization_id, id),
  foreign key (organization_id, hold_id) references holds (organization_id, id),
  foreign key (organization_id, accepted_basket_id) references baskets (organization_id, id),
  foreign key (organization_id, accepted_enrollment_id) references enrollments (organization_id, id),
  foreign key (organization_id, accepted_session_booking_id) references session_bookings (organization_id, id),
  check (expires_at > offered_at),
  check ((status = 'accepted') = (accepted_at is not null)),
  check ((status = 'declined') = (declined_at is not null)),
  check ((status = 'expired') = (expired_at is not null))
);
-- SPK-REG-008: one open offer per entry; acceptance consumes it once (conditional update on 'offered').
create unique index waitlist_offers_open_idx on waitlist_offers (organization_id, waitlist_entry_id) where status = 'offered';
create unique index waitlist_offers_hold_idx on waitlist_offers (organization_id, hold_id);
create trigger waitlist_offers_touch before update on waitlist_offers
  for each row execute function touch_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Trial participations (SPK-YOUTH-003, SPK-AT-019): distinct from enrollments; conversion links
-- the paid enrollment and keeps the trial history.
-- ---------------------------------------------------------------------------------------------

create table trial_participations (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  offering_id uuid not null,                          -- the trial offering
  session_id uuid,
  session_booking_id uuid,
  participant_person_id uuid not null,
  application_id uuid,
  status text not null default 'scheduled' check (status in ('scheduled', 'attended', 'no_show', 'canceled', 'converted')),
  scheduled_for timestamptz,
  attended_at timestamptz,
  canceled_at timestamptz,
  cancel_reason text,
  follow_up_consent boolean not null default false,   -- permitted reuse of information for a follow-up offer
  follow_up jsonb not null default '{}'::jsonb,       -- { suggestedOfferingIds[], notes } never contact details
  converted_enrollment_id uuid,
  converted_basket_id uuid,
  converted_at timestamptz,
  registered_by jsonb not null,
  registered_by_person_id uuid,
  assisted_by_person_id uuid,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, offering_id) references offerings (organization_id, id),
  foreign key (organization_id, session_id) references offering_sessions (organization_id, id),
  foreign key (organization_id, session_booking_id) references session_bookings (organization_id, id),
  foreign key (organization_id, participant_person_id) references persons (organization_id, id),
  foreign key (organization_id, application_id) references applications (organization_id, id),
  foreign key (organization_id, converted_enrollment_id) references enrollments (organization_id, id),
  foreign key (organization_id, converted_basket_id) references baskets (organization_id, id),
  foreign key (organization_id, registered_by_person_id) references persons (organization_id, id),
  foreign key (organization_id, assisted_by_person_id) references persons (organization_id, id),
  check ((status = 'converted') = (converted_enrollment_id is not null and converted_at is not null)),
  check ((status = 'canceled') = (canceled_at is not null))
);
-- One scheduled trial per participant and trial offering (a trial is a try-out, not a series).
create unique index trial_participations_live_idx on trial_participations (organization_id, offering_id, participant_person_id)
  where status = 'scheduled';
create index trial_participations_participant_idx on trial_participations (organization_id, participant_person_id, status);
create trigger trial_participations_touch before update on trial_participations
  for each row execute function touch_updated_at();

alter table enrollments
  add foreign key (organization_id, trial_participation_id) references trial_participations (organization_id, id);

alter table basket_lines
  add foreign key (organization_id, trial_participation_id) references trial_participations (organization_id, id);

-- ---------------------------------------------------------------------------------------------
-- Database guards for the §4.6 machines whose outcome must never be rewritten
-- ---------------------------------------------------------------------------------------------

-- SPK-REG-006: a hold has exactly one terminal outcome. Once committed, released or expired it can
-- never change status again, and its pool and quantity are fixed from acquisition.
create or replace function holds_guard() returns trigger
language plpgsql as $$
begin
  if new.pool_id <> old.pool_id or new.quantity <> old.quantity or new.organization_id <> old.organization_id then
    raise exception 'hold %: pool and quantity are fixed at acquisition', old.id
      using errcode = 'check_violation', constraint = 'holds_one_terminal_outcome';
  end if;
  if old.status <> 'active' and (
       new.status <> old.status
       or new.committed_at is distinct from old.committed_at
       or new.released_at is distinct from old.released_at
       or new.expired_at is distinct from old.expired_at) then
    raise exception 'hold % already has its terminal outcome (%)', old.id, old.status
      using errcode = 'check_violation', constraint = 'holds_one_terminal_outcome';
  end if;
  return new;
end
$$;
create trigger holds_guard before update on holds
  for each row execute function holds_guard();

-- SPK-REG-008: an offer is consumed once; accepted, declined and expired offers are final.
create or replace function waitlist_offers_guard() returns trigger
language plpgsql as $$
begin
  if old.status <> 'offered' and new.status <> old.status then
    raise exception 'waitlist offer % is already %', old.id, old.status
      using errcode = 'check_violation', constraint = 'waitlist_offers_consumed_once';
  end if;
  if new.hold_id <> old.hold_id or new.waitlist_entry_id <> old.waitlist_entry_id then
    raise exception 'waitlist offer %: entry and hold are fixed', old.id
      using errcode = 'check_violation', constraint = 'waitlist_offers_consumed_once';
  end if;
  return new;
end
$$;
create trigger waitlist_offers_guard before update on waitlist_offers
  for each row execute function waitlist_offers_guard();

-- §4.6 EnrollmentMachine (packages/contracts/src/state-machines.ts): pending → confirmed | canceled;
-- confirmed → canceled | transferred | completed; the terminal states never change.
create or replace function enrollments_transition_guard() returns trigger
language plpgsql as $$
begin
  if new.status = old.status then
    return new;
  end if;
  if (old.status = 'pending' and new.status in ('confirmed', 'canceled'))
     or (old.status = 'confirmed' and new.status in ('canceled', 'transferred', 'completed')) then
    return new;
  end if;
  raise exception 'enrollment % cannot move from % to %', old.id, old.status, new.status
    using errcode = 'check_violation', constraint = 'enrollments_machine';
end
$$;
create trigger enrollments_transition_guard before update on enrollments
  for each row execute function enrollments_transition_guard();

-- SPK-YOUTH-004 / SPK-AT-020 / §4.7 invariant 7: the redemption history is the source of the count.
-- Inserting a redemption locks the entitlement, refuses one that is not active, expired at the
-- redemption instant or belongs to someone else, and moves the counter; the check constraint
-- (redeemed_count <= redemption_limit) is the final guarantee against double redemption.
create or replace function makeup_redemptions_apply() returns trigger
language plpgsql as $$
declare
  ent record;
begin
  select id, participant_person_id, status, expires_at, redeemed_count, redemption_limit
    into ent
    from makeup_entitlements
   where organization_id = new.organization_id and id = new.makeup_entitlement_id
   for update;
  if new.kind = 'redeem' then
    if ent.participant_person_id <> new.participant_person_id then
      raise exception 'makeup entitlement % belongs to another participant', ent.id
        using errcode = 'check_violation', constraint = 'makeup_entitlements_within_limit';
    end if;
    if ent.status <> 'active' or ent.expires_at <= new.redeemed_at then
      raise exception 'makeup entitlement % is not redeemable (status %, expires %)', ent.id, ent.status, ent.expires_at
        using errcode = 'check_violation', constraint = 'makeup_entitlements_within_limit';
    end if;
    update makeup_entitlements
       set redeemed_count = redeemed_count + 1,
           status = case when redeemed_count + 1 >= redemption_limit then 'exhausted' else status end,
           revision = revision + 1
     where organization_id = new.organization_id and id = new.makeup_entitlement_id;
  else
    update makeup_entitlements
       set redeemed_count = redeemed_count - 1,
           status = case when status = 'exhausted' then 'active' else status end,
           revision = revision + 1
     where organization_id = new.organization_id and id = new.makeup_entitlement_id;
  end if;
  return null;
end
$$;
create trigger makeup_redemptions_apply after insert on makeup_redemptions
  for each row execute function makeup_redemptions_apply();
