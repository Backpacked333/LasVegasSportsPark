-- SPK-IAM-005 (temporary restrictions) and §4.6 (independent facts must not overwrite one another's
-- state): every access review that restricts a grant records its own suspension of it. A grant is
-- suspended while any suspension that has not ended is in force; lifting one review ends only that
-- review's suspensions, so a grant another open (or closed, not yet lifted) review restricts stays
-- suspended. The access_grants columns suspended_at / suspended_until / suspended_by_review_id /
-- suspension_reason remain the projection of the suspensions in force, maintained by the identity
-- service under the grant's row lock.
--
-- A suspension is ended exactly once (`lift`, or a new restriction by the same review once the
-- earlier one's window has passed) and is otherwise immutable; rows are never deleted.
alter table access_review_decisions
  add constraint access_review_decisions_organization_id_id_key unique (organization_id, id);

create table access_grant_suspensions (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  grant_id uuid not null,
  review_id uuid not null,
  -- null only for suspensions carried over from the single-review columns below
  restrict_decision_id uuid,
  reason text,
  suspended_at timestamptz not null,
  suspended_until timestamptz,
  ended_at timestamptz,
  end_decision_id uuid,
  created_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, grant_id) references access_grants (organization_id, id),
  foreign key (organization_id, review_id) references access_reviews (organization_id, id),
  -- the decision row is written after the grants it affects, in the same transaction
  foreign key (organization_id, restrict_decision_id)
    references access_review_decisions (organization_id, id) deferrable initially deferred,
  foreign key (organization_id, end_decision_id)
    references access_review_decisions (organization_id, id) deferrable initially deferred,
  check (suspended_until is null or suspended_until > suspended_at),
  check ((ended_at is null) = (end_decision_id is null)),
  check (ended_at is null or ended_at >= suspended_at)
);
-- a review holds at most one unended suspension of a grant
create unique index access_grant_suspensions_live_key
  on access_grant_suspensions (organization_id, grant_id, review_id) where ended_at is null;
create index access_grant_suspensions_review_idx
  on access_grant_suspensions (organization_id, review_id) where ended_at is null;

create or replace function access_grant_suspensions_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'access_grant_suspensions is append-only (suspension %)', old.id
      using errcode = 'restrict_violation';
  end if;
  if old.ended_at is not null then
    raise exception 'access_grant_suspensions is append-only: suspension % has ended', old.id
      using errcode = 'restrict_violation';
  end if;
  if new.id <> old.id
     or new.organization_id <> old.organization_id
     or new.grant_id <> old.grant_id
     or new.review_id <> old.review_id
     or new.restrict_decision_id is distinct from old.restrict_decision_id
     or new.reason is distinct from old.reason
     or new.suspended_at <> old.suspended_at
     or new.suspended_until is distinct from old.suspended_until
     or new.created_at <> old.created_at then
    raise exception 'access_grant_suspensions is append-only: only ending suspension % is allowed', old.id
      using errcode = 'restrict_violation';
  end if;
  return new;
end
$$;
create trigger access_grant_suspensions_guard before update or delete on access_grant_suspensions
  for each row execute function access_grant_suspensions_guard();

-- Suspensions recorded before this migration: one unended suspension per suspended grant.
insert into access_grant_suspensions
  (id, organization_id, grant_id, review_id, restrict_decision_id, reason, suspended_at,
   suspended_until)
select gen_random_uuid(), g.organization_id, g.id, g.suspended_by_review_id, null,
       g.suspension_reason, g.suspended_at, g.suspended_until
  from access_grants g
 where g.suspended_by_review_id is not null;
