-- 0515_enrollment_assessment_correction_match.sql
-- Enrollment module, ENR-14 (COMMANDS-03 follow-up): a reviewed correction replaces the assessment
-- it corrects in the family view (§4.7 invariant 9), so it must correct that same observation:
-- the same participant and offering, a template of the same program (a later version is allowed,
-- since the original's template may be retired), the same skill area and the same visibility.
-- A staff-only row therefore never decides what family-visible feedback says (SPK-YOUTH-005 keeps
-- the two separate), and staff of one offering cannot replace another offering's record.
--
-- Checked when a correction is written and while it is in progress (draft, submitted, returned)
-- up to and including its review. Withdrawing a correction is always allowed, and the published,
-- recorded and withdrawn rows written before stay as they are (they are immutable).

create or replace function assessments_correction_match() returns trigger
language plpgsql as $$
declare
  corrected record;
  correction_program uuid;
begin
  if new.corrects_assessment_id is null or new.status = 'withdrawn' then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.status not in ('draft', 'submitted', 'returned') then
    -- A final row: assessments_lifecycle_guard refuses any change to it.
    return new;
  end if;
  select a.participant_person_id, a.offering_id, a.skill_area_key, a.visibility, a.status,
         t.program_id
    into corrected
    from assessments a
    join assessment_templates t
      on t.organization_id = a.organization_id and t.id = a.template_id
   where a.organization_id = new.organization_id and a.id = new.corrects_assessment_id;
  if not found then
    -- The composite foreign key reports a missing corrected row.
    return new;
  end if;
  select program_id into correction_program
    from assessment_templates
   where organization_id = new.organization_id and id = new.template_id;
  if tg_op = 'INSERT' and corrected.status not in ('published', 'recorded') then
    raise exception 'assessment % corrects %, which is not published or recorded',
      new.id, new.corrects_assessment_id
      using errcode = 'check_violation', constraint = 'assessments_correction_match';
  end if;
  if corrected.participant_person_id <> new.participant_person_id
     or corrected.offering_id <> new.offering_id
     or corrected.skill_area_key <> new.skill_area_key
     or corrected.visibility <> new.visibility
     or correction_program is distinct from corrected.program_id then
    raise exception 'assessment % does not correct the same observation as %',
      new.id, new.corrects_assessment_id
      using errcode = 'check_violation', constraint = 'assessments_correction_match';
  end if;
  return new;
end
$$;

create trigger assessments_correction_match before insert or update on assessments
  for each row execute function assessments_correction_match();
