-- Liability waivers (SPK-REG-011, proposed amendment PA-01; Proposed until DEC-095 is answered).
--
-- A waiver is a policy family of its own kind, so its wording is versioned, approved and immutable
-- exactly like every other policy version. An acceptance is an acknowledgment of a waiver version
-- that also says how it was given: digitally, or recorded by staff from a signed paper. A
-- requirement names the waiver by its policy key, never by a version, so a wording change does not
-- by itself undo anybody's acceptance; whether it does is the renewal rule in the version's content.
--
--   * policy_versions.kind gains 'waiver';
--   * acknowledgments gain `method` and `paper_dated_on`. Rows written before this migration are
--     digital with no paper date (the defaults), which is what the new check requires of them;
--   * a paper acceptance is only ever a staff entry: the database refuses one that is not recorded
--     by a named staff member or carries no paper date, and refuses a paper date on a digital
--     acceptance (SPK-REG-009: staff never sign for a customer, and a paper record never reads as
--     the customer's digital signature);
--   * offering_required_waivers: the waiver keys an offering requires;
--   * waiver_overrides: an append-only record of a staff member letting one person take part in
--     one activity although the waiver rule would block.

alter table policy_versions drop constraint policy_versions_kind_check;
alter table policy_versions add constraint policy_versions_kind_check check (kind in (
  'eligibility', 'cancellation', 'refund', 'discount', 'waitlist', 'hold', 'approval', 'form',
  'overpayment', 'installment', 'booking_terms', 'tax_fee', 'waiver'
));

alter table acknowledgments
  add column method text not null default 'digital' check (method in ('digital', 'paper')),
  add column paper_dated_on date;

alter table acknowledgments add constraint acknowledgments_paper_is_staff_entry check (
  (method = 'paper'
     and recorded_by_kind = 'staff'
     and recorded_by_person_id is not null
     and paper_dated_on is not null)
  or (method = 'digital' and paper_dated_on is null)
);

-- The method and the paper date are signer evidence like the rest of the row (0202): after insert
-- the only change is active -> withdrawn.
create or replace function acknowledgments_guard() returns trigger
language plpgsql as $$
begin
  if new.id <> old.id
     or new.organization_id <> old.organization_id
     or new.subject_person_id <> old.subject_person_id
     or new.policy_version_id <> old.policy_version_id
     or new.signed_by_person_id <> old.signed_by_person_id
     or new.basis <> old.basis
     or new.recorded_by is distinct from old.recorded_by
     or new.recorded_by_kind <> old.recorded_by_kind
     or new.recorded_by_person_id is distinct from old.recorded_by_person_id
     or new.signed_at <> old.signed_at
     or new.evidence is distinct from old.evidence
     or new.method <> old.method
     or new.paper_dated_on is distinct from old.paper_dated_on
     or new.created_at <> old.created_at then
    raise exception 'acknowledgment % is signer evidence and cannot be rewritten', old.id
      using errcode = 'restrict_violation';
  end if;
  if old.status = 'withdrawn'
     and (new.status <> old.status
          or new.withdrawn_at is distinct from old.withdrawn_at
          or new.withdrawn_reason is distinct from old.withdrawn_reason) then
    raise exception 'acknowledgment % is withdrawn; its withdrawal is final', old.id
      using errcode = 'restrict_violation';
  end if;
  return new;
end
$$;

-- The waiver families an offering requires, by key (same format as policy_versions.key). The key
-- is deliberately not a foreign key: a family is a set of versions, and which version is in force
-- is decided at the instant of evaluation.
create table offering_required_waivers (
  organization_id uuid not null references organizations(id),
  offering_id uuid not null,
  policy_key text not null check (policy_key ~ '^[a-z0-9][a-z0-9_-]{0,99}$'),
  added_by jsonb not null,
  created_at timestamptz not null default now(),
  primary key (organization_id, offering_id, policy_key),
  foreign key (organization_id, offering_id) references offerings (organization_id, id) on delete cascade
);

-- An override of a blocking waiver rule: who let whom take part in what, and why. Append-only; a
-- mistaken override is answered by the person accepting the waiver, never by editing this record.
create table waiver_overrides (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  person_id uuid not null,
  policy_key text not null check (policy_key ~ '^[a-z0-9][a-z0-9_-]{0,99}$'),
  policy_version_id uuid,                    -- the version in force when the override was recorded
  waiver_status text not null check (waiver_status in ('missing', 'lapsed')),
  activity_type text not null check (activity_type in (
    'offering', 'offering_session', 'scheduling_event', 'booking'
  )),
  activity_id uuid not null,
  reason text not null check (length(btrim(reason)) between 1 and 2000),
  actor jsonb not null,
  actor_person_id uuid not null,             -- the staff member who decided
  occurred_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, person_id) references persons (organization_id, id),
  foreign key (organization_id, actor_person_id) references persons (organization_id, id),
  foreign key (organization_id, policy_version_id) references policy_versions (organization_id, id),
  -- nobody overrides the rule for themselves
  constraint waiver_overrides_not_for_self check (actor_person_id <> person_id)
);
create index waiver_overrides_lookup_idx
  on waiver_overrides (organization_id, person_id, policy_key, activity_type, activity_id, occurred_at desc);
create trigger waiver_overrides_append_only before update or delete on waiver_overrides
  for each row execute function forbid_mutation();
