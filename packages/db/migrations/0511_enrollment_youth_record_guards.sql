-- 0511_enrollment_youth_record_guards.sql
-- Enrollment module, ENR-14 (INTEGRITY-08): what a family was shown, and what a reviewer approves,
-- cannot be rewritten in place (§4.7 invariant 9 "no silent rewriting of published history",
-- SPK-YOUTH-005, SPK-YOUTH-006). The service already edits content only in draft (and returned);
-- the database now refuses any other writer too.
--
--   * progression_recommendations: once shared, the participant, offerings or program, the
--     eligibility snapshot, the suitability text, the author and the share time never change; a
--     withdrawn recommendation never changes at all. The machine (draft → shared | withdrawn,
--     shared → withdrawn) is unchanged.
--   * assessments: while submitted, the content the reviewer approves never changes, the review
--     transition included (published, recorded and withdrawn rows stay immutable as before).

create or replace function progression_recommendations_transition_guard() returns trigger
language plpgsql as $$
begin
  if old.status = 'withdrawn' then
    raise exception 'progression recommendation % is withdrawn and immutable', old.id
      using errcode = 'restrict_violation';
  end if;
  if old.status <> 'draft' and (
       new.participant_person_id <> old.participant_person_id
    or new.from_offering_id <> old.from_offering_id
    or new.recommended_offering_id is distinct from old.recommended_offering_id
    or new.recommended_program_id is distinct from old.recommended_program_id
    or new.eligibility_snapshot is distinct from old.eligibility_snapshot
    or new.suitability <> old.suitability
    or new.author_person_id <> old.author_person_id
    or new.author <> old.author
    or new.shared_at is distinct from old.shared_at
  ) then
    raise exception 'progression recommendation % is % and its content is fixed; withdraw it and share a new one',
      old.id, old.status
      using errcode = 'check_violation', constraint = 'progression_recommendations_content_fixed';
  end if;
  if new.status = old.status then
    return new;
  end if;
  if (old.status = 'draft' and new.status in ('shared', 'withdrawn'))
     or (old.status = 'shared' and new.status = 'withdrawn') then
    return new;
  end if;
  raise exception 'progression recommendation % cannot move from % to %', old.id, old.status, new.status
    using errcode = 'check_violation', constraint = 'progression_recommendations_machine';
end
$$;

create or replace function assessments_lifecycle_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if old.status in ('published', 'recorded') then
      raise exception 'assessment % is % and cannot be deleted', old.id, old.status
        using errcode = 'restrict_violation';
    end if;
    return old;
  end if;
  if old.status in ('published', 'recorded', 'withdrawn') then
    raise exception 'assessment % is % and immutable; record a correction instead', old.id, old.status
      using errcode = 'restrict_violation';
  end if;
  if old.status = 'submitted' and (
       new.template_id <> old.template_id
    or new.participant_person_id <> old.participant_person_id
    or new.offering_id <> old.offering_id
    or new.skill_area_key <> old.skill_area_key
    or new.observed_on <> old.observed_on
    or new.scale_value <> old.scale_value
    or new.comments is distinct from old.comments
    or new.staff_note is distinct from old.staff_note
    or new.visibility <> old.visibility
    or new.author_person_id <> old.author_person_id
    or new.author <> old.author
    or new.corrects_assessment_id is distinct from old.corrects_assessment_id
    or new.correction_reason is distinct from old.correction_reason
  ) then
    raise exception 'assessment % is submitted and its content is fixed until it is returned', old.id
      using errcode = 'check_violation', constraint = 'assessments_submitted_content_fixed';
  end if;
  if new.status = old.status then
    return new;
  end if;
  if (old.status = 'draft' and new.status in ('submitted', 'withdrawn'))
     or (old.status = 'submitted' and new.status in ('published', 'recorded', 'returned'))
     or (old.status = 'returned' and new.status in ('submitted', 'withdrawn')) then
    return new;
  end if;
  raise exception 'assessment % cannot move from % to %', old.id, old.status, new.status
    using errcode = 'check_violation', constraint = 'assessments_machine';
end
$$;
