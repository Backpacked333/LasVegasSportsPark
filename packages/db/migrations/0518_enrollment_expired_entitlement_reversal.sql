-- 0518_enrollment_expired_entitlement_reversal.sql
-- Enrollment module, stage-6 rework of R2-LIFECYCLES-06 and R2-JOURNEYS-01 (SPK-COND-002
-- "reversible according to the cancellation policy", SPK-YOUTH-004 redemption history and expiry,
-- POL-039, §4.6 terminal states are final, §4.7 integrity in the database).
--
-- 0516 refused a reversal only onto a `revoked` or `expired` entitlement. An exhausted package or
-- makeup whose expiry has passed never becomes `expired` (the expiry jobs act on `active` rows and
-- PackageEntitlementMachine has no exhausted -> expire transition), so a reversal onto it still
-- decremented the count and flipped it back to `active` with an expiry in the past: the history and
-- the counter claimed that a credit or makeup came back that can never be redeemed again (the
-- redeem branch of the same trigger refuses `expires_at <= redeemed_at`). An entitlement has ended
-- when its status is terminal or its expiry is at or before the reversal; the reversal branch now
-- refuses both, from any writer. The service records such a canceled package booking as
-- `retained_entitlement_ended` (below) and raises the canceled-session decision without naming a
-- reversal that cannot happen. Redemptions are unchanged; a reversal onto an active or exhausted
-- entitlement whose expiry is still ahead (or has none) behaves exactly as before.
--
-- `session_bookings.credit_disposition` gains `retained_entitlement_ended`: the credit or
-- membership session was kept because the package or membership it came from has ended (revoked,
-- expired, past its expiry; a membership canceled, completed or transferred). Until now such a
-- booking recorded `retained_by_policy`, whose meaning is "kept under the approved cancellation
-- policy" (packages/contracts SessionBookingCreditDisposition), which misled staff about why.

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
    -- A revoked or expired package, or one whose expiry has passed (still `exhausted`), has ended:
    -- nothing is given back to it.
    if ent.status in ('revoked', 'expired')
       or (ent.expires_at is not null and ent.expires_at <= new.redeemed_at) then
      raise exception 'package entitlement % has ended (status %, expires %); no redemption is reversed onto it', ent.id, ent.status, ent.expires_at
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
    -- A revoked or expired makeup, or one whose expiry has passed (still `exhausted`), has ended:
    -- nothing is given back to it.
    if ent.status in ('revoked', 'expired') or ent.expires_at <= new.redeemed_at then
      raise exception 'makeup entitlement % has ended (status %, expires %); no redemption is reversed onto it', ent.id, ent.status, ent.expires_at
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

alter table session_bookings drop constraint session_bookings_credit_disposition_check;
alter table session_bookings add constraint session_bookings_credit_disposition_check
  check (credit_disposition is null or credit_disposition in (
    'returned', 'retained_by_policy', 'retained_pending_policy', 'retained_entitlement_ended'
  ));
