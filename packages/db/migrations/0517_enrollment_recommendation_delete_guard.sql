-- 0517_enrollment_recommendation_delete_guard.sql
-- Enrollment module, R2-SCHEMA-01 (§4.7 invariant 9 no silent rewriting of published history,
-- SPK-YOUTH-006; completes the stage-5 INTEGRITY-08 fix in 0511).
--
-- 0511 made a shared progression recommendation's content fixed and a withdrawn one final, but
-- progression_recommendations_transition_guard is a BEFORE UPDATE trigger: any writer could still
-- DELETE a shared or withdrawn recommendation, and the family-visible recommendation would vanish
-- with its eligibility snapshot and author, leaving no withdrawn record. Nothing references the
-- table, so no foreign key stopped it either. A draft was never shown to the family and may still
-- be deleted; a shared or withdrawn one is history and never is (the service deletes nothing: a
-- shared recommendation is withdrawn, which keeps it). Same shape as policy_versions_no_delete
-- (0201_catalog_history_guards). Assessments already refuse deleting published and recorded rows
-- (0509 assessments_lifecycle_guard), which is what 0509 promises; that branch is unchanged.

create or replace function progression_recommendations_no_delete() returns trigger
language plpgsql as $$
begin
  if old.status <> 'draft' then
    raise exception 'progression recommendation % is % and cannot be deleted', old.id, old.status
      using errcode = 'restrict_violation';
  end if;
  return old;
end
$$;
create trigger progression_recommendations_no_delete before delete on progression_recommendations
  for each row execute function progression_recommendations_no_delete();
