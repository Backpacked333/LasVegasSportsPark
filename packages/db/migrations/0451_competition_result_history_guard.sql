-- 0451_competition_result_history_guard.sql
-- Competition module: result history guard, second pass (§4.7 invariant 9 "no silent rewriting of
-- published history", SPK-RESULT-004 "corrections preserve the prior result, actor, reason and
-- publication time"). Migration 0450 is applied and immutable; this file tightens it.
--
-- 1. The correction chain stays inside one fixture: `supersedes_revision_id` and
--    `superseded_by_revision_id` may only name a revision of the same fixture, and never the row
--    itself.
-- 2. Superseding an official row keeps every fact of it: besides the scores, classification,
--    details, actors (as JSON), reason and publication time already frozen by 0450, the actor
--    person ids, the return (review) facts, the chain pointer to what it superseded, the
--    organization and the creation time are frozen, and the row must name the revision that
--    supersedes it.
-- 3. Only an official row can become superseded (a submitted or draft row never skips publication).
--
-- Publication authority itself (§4.7 invariant 8) is enforced by the publish action
-- (MatchActions.publishResult plus the rule set's approval roles), not by the database.

alter table result_revisions
  add constraint result_revisions_fixture_scoped_key unique (organization_id, fixture_id, id);

alter table result_revisions
  add constraint result_revisions_supersedes_same_fixture
    foreign key (organization_id, fixture_id, supersedes_revision_id)
    references result_revisions (organization_id, fixture_id, id);

alter table result_revisions
  add constraint result_revisions_superseded_by_same_fixture
    foreign key (organization_id, fixture_id, superseded_by_revision_id)
    references result_revisions (organization_id, fixture_id, id);

alter table result_revisions
  add constraint result_revisions_not_superseded_by_self
    check (superseded_by_revision_id is null or superseded_by_revision_id <> id);

create or replace function result_revisions_guard_history() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'result revisions are never deleted; a correction is a new revision'
      using errcode = 'restrict_violation', constraint = 'result_revisions_no_delete';
  end if;
  if old.status = 'superseded' then
    raise exception 'a superseded result revision is immutable history'
      using errcode = 'restrict_violation', constraint = 'result_revisions_history_immutable';
  end if;
  if new.status = 'superseded' and old.status <> 'official' then
    raise exception 'only an official result revision can be superseded'
      using errcode = 'restrict_violation', constraint = 'result_revisions_supersede_official_only';
  end if;
  if old.status = 'official' then
    if new.status <> 'superseded'
       or new.superseded_by_revision_id is null
       or new.organization_id <> old.organization_id
       or new.home_score is distinct from old.home_score
       or new.away_score is distinct from old.away_score
       or new.classification <> old.classification
       or new.forfeiting_entry_id is distinct from old.forfeiting_entry_id
       or new.details <> old.details
       or new.submitted_by <> old.submitted_by
       or new.submitted_by_person_id is distinct from old.submitted_by_person_id
       or new.submitted_at is distinct from old.submitted_at
       or new.returned_at is distinct from old.returned_at
       or new.returned_by is distinct from old.returned_by
       or new.return_reason is distinct from old.return_reason
       or new.published_by is distinct from old.published_by
       or new.published_by_person_id is distinct from old.published_by_person_id
       or new.published_at is distinct from old.published_at
       or new.supersedes_revision_id is distinct from old.supersedes_revision_id
       or new.reason is distinct from old.reason
       or new.fixture_id <> old.fixture_id
       or new.revision_no <> old.revision_no
       or new.created_at <> old.created_at then
      raise exception 'an official result may only be superseded, never rewritten'
        using errcode = 'restrict_violation', constraint = 'result_revisions_official_immutable';
    end if;
  end if;
  return new;
end
$$;
