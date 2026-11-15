-- 0531_enrollment_booking_roster_acceptance.sql
-- Enrollment module: who joined on a rental-roster invitation, and in what capacity
-- (SPK-COND-005, proposed amendment PA-09, capability `rental_rosters`, DEC-103; SPK-IAM-003).
--
-- Migration 0530 recorded only who acted on an acceptance (`accepted_by_person_id`). Nothing in
-- the database tied the person who became a roster member to the person the invitation named, so
-- a holder of the token could mark the named person as joined. This migration records the joiner
-- and the capacity of whoever accepted, and makes the database refuse an acceptance that:
--   * names one person and joins another (`booking_roster_invitations_named_joiner`),
--   * says "self" while the acting person is somebody else, or "representative" while it is the
--     same person (`booking_roster_invitations_capacity`),
--   * leaves the invitation's roster row not joined, or joined as a different person
--     (`booking_roster_invitations_joiner`, a trigger: the roster row is this module's own table).
-- Whether a representative holds registering authority for the joiner is a relationship fact of
-- the identity module; the service checks it inside the unit of work and the audit record names
-- the actor. The database records that the acceptance was made as a representative.
--
-- Rows accepted before this migration are kept and marked `legacy` where the acting person was
-- not the joiner: their capacity was never checked and is not asserted afterwards.

alter table booking_roster_invitations
  add column accepted_for_person_id uuid,           -- the person who joined the roster
  add column accepted_as text
    check (accepted_as in ('self', 'representative', 'legacy'));

alter table booking_roster_invitations
  add constraint booking_roster_invitations_accepted_for_fk
    foreign key (organization_id, accepted_for_person_id)
    references persons (organization_id, id);

update booking_roster_invitations i
   set accepted_for_person_id = m.person_id,
       accepted_as = case
         when i.accepted_by_person_id is not null and i.accepted_by_person_id = m.person_id
           then 'self'
         else 'legacy'
       end
  from booking_roster_members m
 where m.organization_id = i.organization_id
   and m.id = i.member_id
   and i.status = 'accepted';

alter table booking_roster_invitations
  -- An accepted invitation says who joined and in what capacity; no other invitation does.
  add constraint booking_roster_invitations_accepted_fact check (
    (status = 'accepted') = (accepted_for_person_id is not null)
    and (status = 'accepted') = (accepted_as is not null)
  ),
  -- Whoever accepted is recorded (rows from before this migration excepted).
  add constraint booking_roster_invitations_accepted_by check (
    accepted_as is null or accepted_as = 'legacy' or accepted_by_person_id is not null
  ),
  -- An invitation that names a person joins that person and nobody else.
  add constraint booking_roster_invitations_named_joiner check (
    recipient_person_id is null
    or accepted_for_person_id is null
    or accepted_for_person_id = recipient_person_id
  ),
  -- "self" is the joiner acting; "representative" is somebody else acting for them.
  add constraint booking_roster_invitations_capacity check (
    accepted_as is null
    or accepted_as = 'legacy'
    or ((accepted_as = 'self') = (accepted_by_person_id = accepted_for_person_id))
  );

-- At the moment an invitation becomes accepted, its roster row is joined as the recorded joiner.
-- Afterwards the acceptance facts never change (accepted is final in the 0530 guard).
create or replace function booking_roster_invitations_acceptance() returns trigger
language plpgsql as $$
declare
  member_person uuid;
  member_status text;
begin
  if tg_op = 'UPDATE' and old.status = 'accepted' then
    if new.accepted_for_person_id is distinct from old.accepted_for_person_id
       or new.accepted_as is distinct from old.accepted_as
       or new.accepted_by_person_id is distinct from old.accepted_by_person_id
       or new.accepted_at is distinct from old.accepted_at then
      raise exception 'booking roster invitation % was accepted; its acceptance cannot be rewritten', old.id
        using errcode = 'restrict_violation';
    end if;
    return new;
  end if;
  if new.status <> 'accepted' then
    return new;
  end if;
  select person_id, status into member_person, member_status
    from booking_roster_members
   where organization_id = new.organization_id and id = new.member_id;
  if member_status is distinct from 'joined'
     or member_person is distinct from new.accepted_for_person_id then
    raise exception 'booking roster invitation % is accepted for a person who is not its joined roster member', new.id
      using errcode = 'check_violation', constraint = 'booking_roster_invitations_joiner';
  end if;
  return new;
end
$$;
create trigger booking_roster_invitations_acceptance
  before insert or update on booking_roster_invitations
  for each row execute function booking_roster_invitations_acceptance();
