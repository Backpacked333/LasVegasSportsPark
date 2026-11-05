-- 0457_competition_shootout_winner.sql
-- CMP-10 (SPK-COMP-001 bracket progression, SPK-RESULT-005, §4.7 invariants 8 and 9): a drawn
-- playoff game decided by a shootout names its winner on the result revision. A draw is a
-- completed result with equal scores; only such a result may name a shootout winner, and the
-- winner is always one of the fixture's two sides. Whether a shootout may decide a drawn game is
-- the rule set's `tiebreak.playoff` (DEC-002); the service refuses it otherwise.
alter table result_revisions
  add column shootout_winner_entry_id uuid;

alter table result_revisions
  add constraint result_revisions_shootout_winner_fk
    foreign key (organization_id, shootout_winner_entry_id) references team_entries (organization_id, id),
  add constraint result_revisions_shootout_draw check (
    shootout_winner_entry_id is null
    or (classification = 'completed' and home_score is not null and home_score = away_score)
  );

-- The winner is one of the fixture's sides (a foreign key cannot say "home or away").
create or replace function result_revisions_shootout_side_guard() returns trigger
language plpgsql as $$
declare
  home uuid;
  away uuid;
begin
  if new.shootout_winner_entry_id is null then
    return new;
  end if;
  select f.home_entry_id, f.away_entry_id into home, away
    from fixtures f
   where f.organization_id = new.organization_id and f.id = new.fixture_id;
  if new.shootout_winner_entry_id is distinct from home
     and new.shootout_winner_entry_id is distinct from away then
    raise exception 'a shootout winner is one of the fixture''s sides'
      using errcode = 'check_violation', constraint = 'result_revisions_shootout_side';
  end if;
  return new;
end
$$;
create trigger result_revisions_shootout_side_guard
  before insert or update of shootout_winner_entry_id, fixture_id on result_revisions
  for each row execute function result_revisions_shootout_side_guard();

-- §4.7 invariant 9: the history guard of migration 0451 also freezes the shootout winner of an
-- official revision (an official result may only be superseded, never rewritten).
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
       or new.shootout_winner_entry_id is distinct from old.shootout_winner_entry_id
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
