-- 0502_enrollment_trial_no_show_fact.sql
-- Enrollment module: a trial's attendance outcome is its own fact (SPK-YOUTH-003 "trial
-- participation remains distinct from paid enrollment", SPK-AT-019 "separate trial history and
-- paid entitlement", §4.6 independent facts never overwrite one another). Migration 0500 is
-- applied and immutable; this file adds the column.
--
-- `attended` already kept `attended_at` after conversion, but `no_show` lived only in `status`,
-- which conversion replaces with `converted`: a converted no-show read like a trial whose
-- attendance was never recorded. `no_show_at` keeps it, and the outcome facts agree with the
-- status they record.

alter table trial_participations add column no_show_at timestamptz;

-- Existing no-show rows get the time the outcome was last written.
update trial_participations set no_show_at = updated_at where status = 'no_show';

alter table trial_participations
  add constraint trial_participations_no_show_fact
    check (status <> 'no_show' or no_show_at is not null),
  add constraint trial_participations_attended_fact
    check (status <> 'attended' or attended_at is not null),
  add constraint trial_participations_one_attendance_outcome
    check (attended_at is null or no_show_at is null);
