-- 0516_enrollment_ended_entitlement_reversal.sql
-- Enrollment module, R2-LIFECYCLES-06 (SPK-COND-002 "reversible according to the cancellation
-- policy", SPK-YOUTH-004 redemption history, §4.6 terminal states are final).
--
-- A reversal row gives a redemption back: the trigger decremented redeemed_count (and bumped the
-- revision) of the entitlement whatever its status. On a revoked package (its purchase canceled)
-- or an expired one, and on a revoked or expired makeup, that "returned" a credit or a makeup that
-- can never be redeemed again: the history and the counter then claimed something came back.
-- The service no longer writes such a reversal (the canceled booking records what kept the
-- credit, and a staff reversal answers PACKAGE_ENDED); the database now refuses it from any
-- writer. Redemptions are unchanged, and a reversal on an active or exhausted entitlement behaves
-- exactly as before (exhausted becomes active again).

create or replace function package_redemptions_apply() returns trigger
language plpgsql as $$
declare
  ent record;
begin
  select id, participant_person_id, status, expires_at, redeemed_count, credits
    into ent
    from package_entitlements
   where organization_id = new.organization_id and id = new.package_entitlement_id
   for update;
  if new.kind = 'redeem' then
    if ent.participant_person_id <> new.participant_person_id then
      raise exception 'package entitlement % belongs to another participant', ent.id
        using errcode = 'check_violation', constraint = 'package_entitlements_within_limit';
    end if;
    if ent.status <> 'active' or (ent.expires_at is not null and ent.expires_at <= new.redeemed_at) then
      raise exception 'package entitlement % is not redeemable (status %, expires %)', ent.id, ent.status, ent.expires_at
        using errcode = 'check_violation', constraint = 'package_entitlements_within_limit';
    end if;
    update package_entitlements
       set redeemed_count = redeemed_count + 1,
           status = case when redeemed_count + 1 >= credits then 'exhausted' else status end,
           revision = revision + 1
     where organization_id = new.organization_id and id = new.package_entitlement_id;
  else
    if not exists (
      select 1 from package_redemptions r
       where r.organization_id = new.organization_id
         and r.id = new.reverses_redemption_id
         and r.kind = 'redeem'
         and r.package_entitlement_id = new.package_entitlement_id
         and r.session_booking_id = new.session_booking_id
    ) then
      raise exception 'package reversal % must reverse a redemption of the same entitlement and booking', new.id
        using errcode = 'check_violation', constraint = 'package_entitlements_within_limit';
    end if;
    -- R2-LIFECYCLES-06: a revoked or expired package is final; nothing is given back to it.
    if ent.status in ('revoked', 'expired') then
      raise exception 'package entitlement % has ended (status %); no redemption is reversed onto it', ent.id, ent.status
        using errcode = 'check_violation', constraint = 'package_entitlements_ended_no_reversal';
    end if;
    update package_entitlements
       set redeemed_count = redeemed_count - 1,
           status = case when status = 'exhausted' then 'active' else status end,
           revision = revision + 1
     where organization_id = new.organization_id and id = new.package_entitlement_id;
  end if;
  return null;
end
$$;

create or replace function makeup_redemptions_apply() returns trigger
language plpgsql as $$
declare
  ent record;
begin
  select id, participant_person_id, status, expires_at, redeemed_count, redemption_limit
    into ent
    from makeup_entitlements
   where organization_id = new.organization_id and id = new.makeup_entitlement_id
   for update;
  if new.kind = 'redeem' then
    if ent.participant_person_id <> new.participant_person_id then
      raise exception 'makeup entitlement % belongs to another participant', ent.id
        using errcode = 'check_violation', constraint = 'makeup_entitlements_within_limit';
    end if;
    if ent.status <> 'active' or ent.expires_at <= new.redeemed_at then
      raise exception 'makeup entitlement % is not redeemable (status %, expires %)', ent.id, ent.status, ent.expires_at
        using errcode = 'check_violation', constraint = 'makeup_entitlements_within_limit';
    end if;
    update makeup_entitlements
       set redeemed_count = redeemed_count + 1,
           status = case when redeemed_count + 1 >= redemption_limit then 'exhausted' else status end,
           revision = revision + 1
     where organization_id = new.organization_id and id = new.makeup_entitlement_id;
  else
    -- A reversal corrects exactly one redemption of the same entitlement and booking; a
    -- reversal of a reversal (which would hand out a second free redemption) is refused.
    if not exists (
      select 1 from makeup_redemptions r
       where r.organization_id = new.organization_id
         and r.id = new.reverses_redemption_id
         and r.kind = 'redeem'
         and r.makeup_entitlement_id = new.makeup_entitlement_id
         and r.session_booking_id = new.session_booking_id
    ) then
      raise exception 'makeup reversal % must reverse a redemption of the same entitlement and booking', new.id
        using errcode = 'check_violation', constraint = 'makeup_entitlements_within_limit';
    end if;
    -- R2-LIFECYCLES-06: a revoked or expired makeup is final; nothing is given back to it.
    if ent.status in ('revoked', 'expired') then
      raise exception 'makeup entitlement % has ended (status %); no redemption is reversed onto it', ent.id, ent.status
        using errcode = 'check_violation', constraint = 'makeup_entitlements_ended_no_reversal';
    end if;
    update makeup_entitlements
       set redeemed_count = redeemed_count - 1,
           status = case when status = 'exhausted' then 'active' else status end,
           revision = revision + 1
     where organization_id = new.organization_id and id = new.makeup_entitlement_id;
  end if;
  return null;
end
$$;
