-- 0510_enrollment_assessment_corrections.sql
-- Enrollment module, ENR-14 (COMMANDS-03): a correction of a published or recorded assessment says
-- why (§4.9 "reason for overrides or corrections"), and only one correction of an assessment is
-- live at a time, so the family view can tell which value stands (§4.7 invariant 9, SPK-YOUTH-005).
--
--   * correction_reason: required on a correction (corrects_assessment_id set) and only there.
--   * assessments_one_live_correction_idx: at most one correction of an assessment that is not
--     withdrawn; a later correction corrects the standing correction instead.

alter table assessments
  add column correction_reason text
    check (correction_reason is null or length(correction_reason) between 1 and 2000);

-- Corrections still in progress (draft, submitted, returned) were written before the reason was
-- captured; they get an explicit marker rather than an invented reason. Published, recorded and
-- withdrawn rows are immutable (assessments_lifecycle_guard) and are not rewritten: the check below
-- is NOT VALID, so it binds every new or changed row without validating those.
update assessments
   set correction_reason = 'Not recorded (correction written before the reason was required)'
 where corrects_assessment_id is not null
   and correction_reason is null
   and status in ('draft', 'submitted', 'returned');

alter table assessments
  add constraint assessments_correction_reason
    check ((corrects_assessment_id is null) = (correction_reason is null)) not valid;

create unique index assessments_one_live_correction_idx
  on assessments (organization_id, corrects_assessment_id)
  where corrects_assessment_id is not null and status <> 'withdrawn';
