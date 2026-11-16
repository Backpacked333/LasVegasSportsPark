-- 0696_finance_pos_line_approvals.sql
-- SPK-PAY-016 (proposed amendment PA-08, DEC-102 pending): the second approval of an open-amount
-- register line above the ceiling of the person who entered it. Its own record, written by its own
-- command: who approved, when, why, and the amount and ceiling the approval was given for.
--
-- Enforced here (the service checks the same first):
--   * an approval is for a line in effect of an open sale that needs one, and repeats the line's
--     amount, ceiling and currency (pos_line_approvals_open_sale, pos_line_approvals_line,
--     pos_line_approvals_facts);
--   * the approver is never the person who entered the line (pos_line_approvals_second_person);
--   * one approval per line (unique), never rewritten or deleted (forbid_mutation);
--   * a sale takes no tender and is never paid while one of its lines in effect still needs an
--     approval (pos_tenders_open_amount_approved, pos_sales_open_amount_approved). A void needs
--     none, and removing the line (0695) lifts the block.
-- The existing sale, tender and line triggers are left as they are; the two guards below are
-- additional triggers, not replacements.

create table pos_line_approvals (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  sale_id uuid not null,
  sale_line_id uuid not null,
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  amount_minor bigint not null check (amount_minor > 0),
  ceiling_minor bigint not null check (ceiling_minor >= 0),
  reason text not null check (length(btrim(reason)) between 1 and 2000),
  approved_by jsonb not null,
  approved_by_person_id uuid not null,
  approved_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, sale_line_id),
  foreign key (organization_id, sale_id, sale_line_id)
    references pos_sale_lines (organization_id, sale_id, id),
  foreign key (organization_id, approved_by_person_id) references persons (organization_id, id),
  constraint pos_line_approvals_above_ceiling check (amount_minor > ceiling_minor)
);
create index pos_line_approvals_sale_idx on pos_line_approvals (organization_id, sale_id);
create trigger pos_line_approvals_append_only before update or delete on pos_line_approvals
  for each row execute function forbid_mutation();

create or replace function pos_line_approvals_guard() returns trigger
language plpgsql as $$
declare
  sale_status text;
  line record;
begin
  select status into sale_status from pos_sales
   where organization_id = new.organization_id and id = new.sale_id for update;
  if sale_status is distinct from 'open' then
    raise exception 'pos sale % is % and its lines take no approval', new.sale_id,
      coalesce(sale_status, 'missing')
      using errcode = 'check_violation', constraint = 'pos_line_approvals_open_sale';
  end if;
  select kind, quantity, currency, unit_price_minor, approval_ceiling_minor, approval_required,
         entered_by_person_id
    into line from pos_sale_lines
   where organization_id = new.organization_id and sale_id = new.sale_id
     and id = new.sale_line_id;
  if line.kind is distinct from 'open_amount' or line.approval_required is distinct from true
     or line.quantity < 1
     or exists (select 1 from pos_sale_lines n
                 where n.organization_id = new.organization_id
                   and n.supersedes_line_id = new.sale_line_id) then
    raise exception 'pos sale line % is not an open-amount line in effect that needs an approval',
      new.sale_line_id
      using errcode = 'check_violation', constraint = 'pos_line_approvals_line';
  end if;
  if new.approved_by_person_id = line.entered_by_person_id then
    raise exception 'pos sale line % cannot be approved by the person who entered it',
      new.sale_line_id
      using errcode = 'check_violation', constraint = 'pos_line_approvals_second_person';
  end if;
  if new.amount_minor <> line.unit_price_minor or new.ceiling_minor <> line.approval_ceiling_minor
     or new.currency <> line.currency then
    raise exception 'approval % does not repeat the amount, ceiling and currency of line %',
      new.id, new.sale_line_id
      using errcode = 'check_violation', constraint = 'pos_line_approvals_facts';
  end if;
  return new;
end
$$;
create trigger pos_line_approvals_guard before insert on pos_line_approvals
  for each row execute function pos_line_approvals_guard();

-- True when a line in effect of the sale is above its ceiling and nobody approved it yet.
create or replace function pos_sale_awaits_line_approval(org uuid, sale uuid) returns boolean
language sql stable as $$
  select exists (
    select 1 from pos_sale_lines l
     where l.organization_id = org and l.sale_id = sale
       and l.kind = 'open_amount' and l.approval_required and l.quantity > 0
       and not exists (select 1 from pos_sale_lines n
                        where n.organization_id = l.organization_id
                          and n.supersedes_line_id = l.id)
       and not exists (select 1 from pos_line_approvals a
                        where a.organization_id = l.organization_id
                          and a.sale_line_id = l.id)
  )
$$;

-- No tender while an approval is outstanding. The sale row is locked first, as every other
-- writer of a sale's parts does, so an approval and a tender never pass each other.
create or replace function pos_tenders_open_amount_approved() returns trigger
language plpgsql as $$
begin
  perform 1 from pos_sales
   where organization_id = new.organization_id and id = new.sale_id for update;
  if pos_sale_awaits_line_approval(new.organization_id, new.sale_id) then
    raise exception 'pos sale % has an open-amount line above its ceiling that is not approved',
      new.sale_id
      using errcode = 'check_violation', constraint = 'pos_tenders_open_amount_approved';
  end if;
  return new;
end
$$;
create trigger pos_tenders_open_amount_approved before insert on pos_tenders
  for each row execute function pos_tenders_open_amount_approved();

-- Nor is the sale paid (a line may be added after a tender was taken).
create or replace function pos_sales_open_amount_approved() returns trigger
language plpgsql as $$
begin
  if pos_sale_awaits_line_approval(new.organization_id, new.id) then
    raise exception 'pos sale % has an open-amount line above its ceiling that is not approved',
      new.id
      using errcode = 'check_violation', constraint = 'pos_sales_open_amount_approved';
  end if;
  return new;
end
$$;
create trigger pos_sales_open_amount_approved before update on pos_sales
  for each row when (old.status = 'open' and new.status = 'paid')
  execute function pos_sales_open_amount_approved();
