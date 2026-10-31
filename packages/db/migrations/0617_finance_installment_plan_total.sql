-- 0617_finance_installment_plan_total.sql
-- R3-TIME-MONEY-08 (SPK-PAY-006 "plans record amounts"; SPK-PAY-004 total, received, allocated and
-- remaining shown consistently; CLAUDE.md "integrity that matters is enforced in the database").
--
-- A plan that used a credit stored total_minor = order total - credits applied, while its first
-- installment (and that installment's obligation) carried due now + credits applied, with the
-- credits as allocations against it. The installments therefore added up to more than the plan
-- total the API returns (30000 total, 6000 credit, three installments: total 24000 above
-- installments of 14000, 8000 and 8000). The plan total is now the sum of its installments (the
-- order total); credits stay allocations against installment 1.
--
-- 1. Repair: every existing plan whose installments add up to another amount takes their sum
--    (the only writer, checkout, always created the installments with the plan, so the sum is the
--    order total).
-- 2. Guarantee: deferred to commit (checkout inserts the plan before its installments, in one
--    transaction), a plan whose installments do not add up to total_minor is refused with
--    check_violation installment_plans_total_matches_installments. It runs when a plan is created
--    or its total changes, and when an installment is created, removed or its amount or plan
--    changes; a status change, hold or extension leaves the amounts alone and is not re-checked.

update installment_plans p
   set total_minor = s.summed
  from (select organization_id, plan_id, sum(amount_minor)::bigint as summed
          from installments
         group by organization_id, plan_id) s
 where s.organization_id = p.organization_id
   and s.plan_id = p.id
   and s.summed <> p.total_minor;

create or replace function installment_plan_total_matches(org uuid, plan uuid) returns void
language plpgsql as $$
declare
  plan_total bigint;
  summed bigint;
begin
  select total_minor into plan_total
    from installment_plans where organization_id = org and id = plan;
  if plan_total is null then
    return;
  end if;
  select coalesce(sum(amount_minor), 0)::bigint into summed
    from installments where organization_id = org and plan_id = plan;
  if summed <> plan_total then
    raise exception 'installment plan % totals % but its installments add up to %',
        plan, plan_total, summed
      using errcode = 'check_violation',
            constraint = 'installment_plans_total_matches_installments',
            table = 'installment_plans';
  end if;
end
$$;

create or replace function installment_plans_total_check() returns trigger
language plpgsql as $$
begin
  perform installment_plan_total_matches(new.organization_id, new.id);
  return null;
end
$$;

create or replace function installments_plan_total_check() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    perform installment_plan_total_matches(old.organization_id, old.plan_id);
    return null;
  end if;
  perform installment_plan_total_matches(new.organization_id, new.plan_id);
  if tg_op = 'UPDATE' then
    if old.plan_id is distinct from new.plan_id then
      perform installment_plan_total_matches(old.organization_id, old.plan_id);
    end if;
  end if;
  return null;
end
$$;

create constraint trigger installment_plans_total_matches_installments
  after insert or update of total_minor on installment_plans
  deferrable initially deferred for each row
  execute function installment_plans_total_check();

create constraint trigger installments_total_matches_plan
  after insert or update of amount_minor, plan_id or delete on installments
  deferrable initially deferred for each row
  execute function installments_plan_total_check();
