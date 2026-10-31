-- 0613_finance_installment_plan_hold.sql
-- MONEY-04 (SPK-PAY-006, SPK-AT-006, §4.11 step 10: never charge for a registration the family
-- did not receive; DEC-009 pending): once every registration an installment plan pays for was
-- canceled, the plan is held. The hold was re-derived on every collection, so the finance
-- operator's exception came back after each resolution and the payer was still sent the notice
-- of a charge that would never be made. The hold is now a recorded fact on the plan: set once
-- (with the one exception it raises), never lifted silently, and the database refuses a new
-- installment charge for a held plan.

alter table installment_plans
  add column held_at timestamptz,
  add column hold_reason text,
  add constraint installment_plans_hold_fact check ((held_at is null) = (hold_reason is null)),
  add constraint installment_plans_hold_reason check (
    hold_reason is null or hold_reason in ('registrations_canceled')
  );

-- Until the cancellation decision (DEC-009) has a command that ends a hold, a recorded hold is
-- never changed or cleared.
create or replace function installment_plans_hold_guard() returns trigger
language plpgsql as $$
begin
  if old.held_at is not null and (new.held_at is distinct from old.held_at
     or new.hold_reason is distinct from old.hold_reason) then
    raise exception 'the hold of installment plan % is recorded once', old.id
      using errcode = 'check_violation', constraint = 'installment_plans_hold_recorded';
  end if;
  return new;
end
$$;
create trigger installment_plans_hold_guard before update on installment_plans
  for each row execute function installment_plans_hold_guard();

-- A held plan is never charged: no new installment payment attempt names one of its installments.
create or replace function payment_attempts_installment_plan_held() returns trigger
language plpgsql as $$
begin
  if new.installment_id is not null and exists (
    select 1
      from installments i
      join installment_plans p on p.organization_id = i.organization_id and p.id = i.plan_id
     where i.organization_id = new.organization_id
       and i.id = new.installment_id
       and p.held_at is not null
  ) then
    raise exception 'installment % belongs to a held plan', new.installment_id
      using errcode = 'check_violation', constraint = 'payment_attempts_installment_plan_held';
  end if;
  return new;
end
$$;
create trigger payment_attempts_installment_plan_held before insert on payment_attempts
  for each row execute function payment_attempts_installment_plan_held();
