-- Acknowledgment guard (SPK-REG-009 signer evidence, §4.4 Acknowledgment; CLAUDE.md "integrity
-- that matters is enforced in the database").
--
-- An acknowledgment is evidence of who signed which policy version for whom, when, and who
-- recorded it. Migration 0200 gave the table only the updated_at touch, so any UPDATE could
-- rewrite the signer, the signing instant or the evidence. After insert the only change allowed
-- is active -> withdrawn (withdrawn_at and the reason) with the revision and updated_at bump; a
-- withdrawal is final and no acknowledgment is ever deleted (a correction is a new
-- acknowledgment). Bounds on signed_at against the clock stay in the catalog service, which reads
-- the injected Clock: comparing with now() here would disagree with the domain clock.

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
create trigger acknowledgments_guard before update on acknowledgments
  for each row execute function acknowledgments_guard();
create trigger acknowledgments_no_delete before delete on acknowledgments
  for each row execute function forbid_mutation();
