-- 0100_identity_core.sql
-- Identity module (specification §3.1 SPK-IAM-001..007, §4.4 Identity, §4.5, §4.14).
--
-- Person, login account, household, relationship, access grant, invitation, claim, staff
-- assignment and disputed-access review are separate records (SPK-IAM-001). Nothing in this
-- schema lets a shared household, surname or contact point establish authority: authority is only
-- an unrevoked, unsuspended, currently effective access_grants row hanging off a relationship.
-- Child information is minimized to name, date of birth and kind (§4.14).

-- ---------------------------------------------------------------------------------------------
-- Persons (SPK-IAM-001). `kind` is derived from date of birth when known and otherwise declared.
-- A merged person keeps its row (status 'merged') so history remains reachable (SPK-IAM-007).
-- ---------------------------------------------------------------------------------------------
create table persons (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  kind text not null check (kind in ('adult', 'child')),
  given_name text not null check (length(given_name) between 1 and 200),
  family_name text not null check (length(family_name) between 1 and 200),
  date_of_birth date,
  status text not null default 'active' check (status in ('active', 'inactive', 'merged')),
  merged_into_person_id uuid,
  source text not null check (source in ('staff', 'self_service', 'import')),
  created_by jsonb not null,
  created_by_person_id uuid,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, merged_into_person_id) references persons (organization_id, id),
  foreign key (organization_id, created_by_person_id) references persons (organization_id, id),
  check ((status = 'merged') = (merged_into_person_id is not null)),
  check (merged_into_person_id is null or merged_into_person_id <> id)
);
create index persons_name_idx on persons (organization_id, lower(family_name), lower(given_name));
create index persons_dob_idx on persons (organization_id, date_of_birth) where date_of_birth is not null;
create trigger persons_touch before update on persons
  for each row execute function touch_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Contact points. A verified primary identifier belongs to exactly one person in the organization;
-- unverified values may repeat (a parent typing a child's email does not claim it).
-- ---------------------------------------------------------------------------------------------
create table contact_points (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  person_id uuid not null,
  kind text not null check (kind in ('email', 'phone')),
  value text not null check (length(value) between 3 and 320),
  is_primary boolean not null default false,
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, person_id) references persons (organization_id, id)
);
create unique index contact_points_primary_idx on contact_points (organization_id, person_id, kind)
  where is_primary;
create unique index contact_points_verified_identifier_idx on contact_points (organization_id, kind, value)
  where verified_at is not null and is_primary;
create index contact_points_lookup_idx on contact_points (organization_id, kind, value);
create trigger contact_points_touch before update on contact_points
  for each row execute function touch_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Login accounts (SPK-IAM-002). (issuer, subject) is the identity-provider identity; a person has
-- at most one active account; an account may exist before it is linked to a person (claim flow).
-- Recovery re-links the same account to a new provider identity and never touches grants (SPK-AT-025).
-- ---------------------------------------------------------------------------------------------
create table accounts (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  issuer text not null check (length(issuer) between 1 and 500),
  subject text not null check (length(subject) between 1 and 500),
  person_id uuid,
  status text not null default 'active' check (status in ('active', 'disabled')),
  last_login_at timestamptz,
  disabled_at timestamptz,
  disabled_reason text,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (issuer, subject),
  unique (organization_id, id),
  foreign key (organization_id, person_id) references persons (organization_id, id),
  check ((status = 'disabled') = (disabled_at is not null))
);
create unique index accounts_one_active_per_person_idx on accounts (organization_id, person_id)
  where status = 'active' and person_id is not null;
create trigger accounts_touch before update on accounts
  for each row execute function touch_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Households group people for convenience only (§4.5: Person.householdId cannot determine authority).
-- ---------------------------------------------------------------------------------------------
create table households (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  name text not null check (length(name) between 1 and 200),
  created_by jsonb not null,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id)
);
create trigger households_touch before update on households
  for each row execute function touch_updated_at();

create table household_memberships (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  household_id uuid not null,
  person_id uuid not null,
  label text check (label is null or length(label) between 1 and 100),
  added_by jsonb not null,
  created_at timestamptz not null default now(),
  unique (organization_id, household_id, person_id),
  unique (organization_id, id),
  foreign key (organization_id, household_id) references households (organization_id, id),
  foreign key (organization_id, person_id) references persons (organization_id, id)
);

-- ---------------------------------------------------------------------------------------------
-- Relationships: who stands in which capacity to whom. A relationship carries no permission by
-- itself; permissions are individual access_grants rows (SPK-IAM-003).
-- ---------------------------------------------------------------------------------------------
create table relationships (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  actor_person_id uuid not null,
  subject_person_id uuid not null,
  kind text not null check (kind in ('guardian', 'delegate', 'caregiver', 'self_managed')),
  status text not null default 'active' check (status in ('active', 'suspended', 'ended')),
  effective_from timestamptz not null,
  effective_to timestamptz,
  source text not null check (source in ('staff', 'self_service', 'invitation', 'claim', 'review', 'import')),
  created_by jsonb not null,
  ended_at timestamptz,
  ended_reason text,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, id, actor_person_id, subject_person_id),
  foreign key (organization_id, actor_person_id) references persons (organization_id, id),
  foreign key (organization_id, subject_person_id) references persons (organization_id, id),
  check ((kind = 'self_managed') = (actor_person_id = subject_person_id)),
  check (effective_to is null or effective_to > effective_from),
  check ((status = 'ended') = (ended_at is not null))
);
create unique index relationships_live_idx on relationships (organization_id, actor_person_id, subject_person_id, kind)
  where status in ('active', 'suspended');
create index relationships_subject_idx on relationships (organization_id, subject_person_id);
create trigger relationships_touch before update on relationships
  for each row execute function touch_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Access grants (SPK-IAM-003/006). One row per (actor, subject, permission); one permission never
-- implies another. The four-column foreign key guarantees a grant can only belong to a relationship
-- between the same two people (deferred so a merge can re-point relationship and grants together).
-- The exclusion constraint forbids two overlapping unrevoked grants for the same permission.
-- Revocation keeps the row (revoked_at) so history stays auditable; suspension by an access review
-- keeps the row and removes its effect (SPK-IAM-005 temporary restrictions).
-- ---------------------------------------------------------------------------------------------
create table access_grants (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  relationship_id uuid not null,
  actor_person_id uuid not null,
  subject_person_id uuid not null,
  permission text not null check (permission in ('view', 'register', 'pay', 'receive_messages', 'complete_forms', 'collect')),
  source text not null check (source in ('invitation', 'staff', 'claim', 'review', 'self_service', 'import')),
  granted_by jsonb not null,
  effective_from timestamptz not null,
  effective_to timestamptz,
  revoked_at timestamptz,
  revoked_by jsonb,
  revocation_reason text,
  suspended_at timestamptz,
  suspended_by_review_id uuid,
  suspension_reason text,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, relationship_id, actor_person_id, subject_person_id)
    references relationships (organization_id, id, actor_person_id, subject_person_id)
    deferrable initially deferred,
  foreign key (organization_id, actor_person_id) references persons (organization_id, id),
  foreign key (organization_id, subject_person_id) references persons (organization_id, id),
  check (actor_person_id <> subject_person_id),
  check (effective_to is null or effective_to > effective_from),
  check ((revoked_at is null) = (revoked_by is null)),
  check ((suspended_at is null) = (suspended_by_review_id is null)),
  exclude using gist (
    organization_id with =,
    actor_person_id with =,
    subject_person_id with =,
    permission with =,
    (tstzrange(effective_from, effective_to, '[)')) with &&
  ) where (revoked_at is null)
);
create index access_grants_subject_idx on access_grants (organization_id, subject_person_id, permission)
  where revoked_at is null;
create index access_grants_actor_idx on access_grants (organization_id, actor_person_id)
  where revoked_at is null;
create trigger access_grants_touch before update on access_grants
  for each row execute function touch_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Invitations (SPK-IAM-004): inviting actor, recipient, scope, requested permissions, expiry,
-- acceptance and revocation are all recorded. Only the token hash is stored.
-- ---------------------------------------------------------------------------------------------
create table invitations (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  invited_by jsonb not null,
  invited_by_person_id uuid,
  recipient_person_id uuid,
  recipient_contact_kind text check (recipient_contact_kind in ('email', 'phone')),
  recipient_contact_value text,
  scope_type text not null check (scope_type in ('person', 'household')),
  scope_person_id uuid,
  scope_household_id uuid,
  relationship_kind text not null check (relationship_kind in ('guardian', 'delegate', 'caregiver')),
  requested_permissions text[] not null check (
    cardinality(requested_permissions) >= 1
    and requested_permissions <@ array['view', 'register', 'pay', 'receive_messages', 'complete_forms', 'collect']::text[]
  ),
  token_hash text not null unique,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'revoked', 'expired')),
  expires_at timestamptz not null,
  accepted_at timestamptz,
  accepted_by_person_id uuid,
  granted_permissions text[] not null default '{}',
  revoked_at timestamptz,
  revoked_by jsonb,
  revocation_reason text,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, invited_by_person_id) references persons (organization_id, id),
  foreign key (organization_id, recipient_person_id) references persons (organization_id, id),
  foreign key (organization_id, accepted_by_person_id) references persons (organization_id, id),
  foreign key (organization_id, scope_person_id) references persons (organization_id, id),
  foreign key (organization_id, scope_household_id) references households (organization_id, id),
  check ((scope_type = 'person') = (scope_person_id is not null)),
  check ((scope_type = 'household') = (scope_household_id is not null)),
  check (recipient_person_id is not null or recipient_contact_value is not null),
  check ((recipient_contact_kind is null) = (recipient_contact_value is null)),
  check ((status = 'accepted') = (accepted_at is not null)),
  check ((status = 'revoked') = (revoked_at is not null))
);
create index invitations_recipient_idx on invitations (organization_id, recipient_person_id) where status = 'pending';
create trigger invitations_touch before update on invitations
  for each row execute function touch_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Claims (SPK-IAM-002): a staff-created participant is later claimed by a verified customer without
-- creating a second person. `self` links the claimant's account to the person; `guardian` creates a
-- guardian relationship with the requested permissions.
-- ---------------------------------------------------------------------------------------------
create table claims (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  subject_person_id uuid not null,
  kind text not null check (kind in ('self', 'guardian')),
  requested_permissions text[] not null default '{}' check (
    requested_permissions <@ array['view', 'register', 'pay', 'receive_messages', 'complete_forms', 'collect']::text[]
  ),
  issued_by jsonb not null,
  recipient_contact_kind text check (recipient_contact_kind in ('email', 'phone')),
  recipient_contact_value text,
  token_hash text not null unique,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'revoked', 'expired')),
  expires_at timestamptz not null,
  accepted_at timestamptz,
  accepted_by_account_id uuid,
  accepted_by_person_id uuid,
  revoked_at timestamptz,
  revoked_by jsonb,
  revocation_reason text,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, subject_person_id) references persons (organization_id, id),
  foreign key (organization_id, accepted_by_account_id) references accounts (organization_id, id),
  foreign key (organization_id, accepted_by_person_id) references persons (organization_id, id),
  check ((kind = 'self') = (cardinality(requested_permissions) = 0)),
  check ((recipient_contact_kind is null) = (recipient_contact_value is null)),
  check ((status = 'accepted') = (accepted_at is not null)),
  check ((status = 'revoked') = (revoked_at is not null))
);
create trigger claims_touch before update on claims
  for each row execute function touch_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Staff memberships (§2.1): time-bounded role assignments. Staff authority comes only from here;
-- a coach who is also a parent gets guardian authority only through access_grants.
-- facility_ids is validated by the service against the organization's facilities (array columns
-- cannot carry a composite foreign key); empty means every facility in the organization.
-- ---------------------------------------------------------------------------------------------
create table staff_memberships (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  person_id uuid not null,
  roles text[] not null check (
    cardinality(roles) >= 1
    and roles <@ array['front_desk', 'league_manager', 'program_manager', 'scheduler', 'finance_operator',
                       'facilities_operator', 'general_manager', 'system_administrator', 'support_operator',
                       'coach', 'official']::text[]
  ),
  facility_ids uuid[] not null default '{}',
  status text not null default 'active' check (status in ('active', 'ended')),
  effective_from timestamptz not null,
  effective_to timestamptz,
  ended_at timestamptz,
  ended_reason text,
  created_by jsonb not null,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, person_id) references persons (organization_id, id),
  -- >= : a membership ended at the instant it started has an empty window and never took effect
  check (effective_to is null or effective_to >= effective_from),
  check ((status = 'ended') = (ended_at is not null))
);
create index staff_memberships_person_idx on staff_memberships (organization_id, person_id) where status = 'active';
create trigger staff_memberships_touch before update on staff_memberships
  for each row execute function touch_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Disputed access reviews (SPK-IAM-005): restricted workflow with temporary restrictions, evidence
-- references, ownership, append-only decision history, effective dates and escalation. The
-- application never infers a resolution from family membership.
-- ---------------------------------------------------------------------------------------------
create table access_reviews (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  subject_person_id uuid not null,
  opened_by jsonb not null,
  opened_by_person_id uuid,
  reason text not null check (length(reason) between 1 and 4000),
  parties jsonb not null default '[]'::jsonb,
  evidence jsonb not null default '[]'::jsonb,
  owner_role text not null check (owner_role in ('general_manager', 'system_administrator', 'support_operator')),
  owner_person_id uuid,
  status text not null default 'open' check (status in ('open', 'escalated', 'decided', 'closed')),
  effective_from timestamptz not null,
  effective_to timestamptz,
  escalated_at timestamptz,
  decided_at timestamptz,
  closed_at timestamptz,
  outcome jsonb,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, subject_person_id) references persons (organization_id, id),
  foreign key (organization_id, opened_by_person_id) references persons (organization_id, id),
  foreign key (organization_id, owner_person_id) references persons (organization_id, id),
  -- >= : a review closed at the instant it opened has an empty effective window
  check (effective_to is null or effective_to >= effective_from),
  check ((status = 'closed') = (closed_at is not null))
);
create index access_reviews_subject_idx on access_reviews (organization_id, subject_person_id, status);
create trigger access_reviews_touch before update on access_reviews
  for each row execute function touch_updated_at();

create table access_review_decisions (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  review_id uuid not null,
  sequence integer not null check (sequence >= 1),
  kind text not null check (kind in ('restrict', 'lift', 'escalate', 'decide', 'close', 'note', 'reassign')),
  decided_by jsonb not null,
  note text,
  affected_grant_ids uuid[] not null default '{}',
  effective_from timestamptz,
  effective_to timestamptz,
  details jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  unique (organization_id, review_id, sequence),
  foreign key (organization_id, review_id) references access_reviews (organization_id, id)
);
create trigger access_review_decisions_append_only before update or delete on access_review_decisions
  for each row execute function forbid_mutation();

alter table access_grants
  add constraint access_grants_suspended_by_review_fk
  foreign key (organization_id, suspended_by_review_id) references access_reviews (organization_id, id);

-- ---------------------------------------------------------------------------------------------
-- Duplicate review (SPK-IAM-007). Candidates are canonical pairs (a < b); a merge is an append-only
-- fact that keeps the merged person's history reachable and never imports unverified permissions.
-- ---------------------------------------------------------------------------------------------
create table duplicate_candidates (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  person_a_id uuid not null,
  person_b_id uuid not null,
  reasons text[] not null check (cardinality(reasons) >= 1),
  score integer not null check (score between 0 and 100),
  status text not null default 'open' check (status in ('open', 'merged', 'dismissed')),
  flagged_by jsonb not null,
  decision jsonb,
  decided_by jsonb,
  decided_at timestamptz,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, person_a_id, person_b_id),
  foreign key (organization_id, person_a_id) references persons (organization_id, id),
  foreign key (organization_id, person_b_id) references persons (organization_id, id),
  check (person_a_id < person_b_id),
  check ((status = 'open') = (decided_at is null))
);
create trigger duplicate_candidates_touch before update on duplicate_candidates
  for each row execute function touch_updated_at();

create table person_merges (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  survivor_person_id uuid not null,
  merged_person_id uuid not null,
  candidate_id uuid,
  moved jsonb not null,
  actor jsonb not null,
  reason text,
  operation_id uuid references operations(id),
  occurred_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, survivor_person_id) references persons (organization_id, id),
  foreign key (organization_id, merged_person_id) references persons (organization_id, id),
  foreign key (organization_id, candidate_id) references duplicate_candidates (organization_id, id),
  check (survivor_person_id <> merged_person_id)
);
create unique index person_merges_merged_once_idx on person_merges (organization_id, merged_person_id);
create index person_merges_survivor_idx on person_merges (organization_id, survivor_person_id);
create trigger person_merges_append_only before update or delete on person_merges
  for each row execute function forbid_mutation();
