-- 0216_catalog_offering_addons.sql
-- Catalog module. Proposed amendment PA-03 (SPK-PAY-014); Proposed, open values Pending decision
-- (DEC-097: which add-ons exist and their capacity). Capability price_tiers_addons.
--
-- An add-on is an optional extra of an offering (lunch, early drop-off) with its own price,
-- selected once for the registration ('per_registration') or for each session the customer picks
-- ('per_session'), and optionally limited by its own capacity (enrollment sizes a capacity pool of
-- scope 'addon' from `capacity`: places in all for 'per_registration', places for each session
-- for 'per_session'; null is unlimited).
--
-- Invariants enforced here:
--   * an add-on belongs to an offering of its own organization (composite foreign key, §4.3);
--   * one live add-on per code and offering (offering_addons_live_code_idx);
--   * the price, currency, charge lines, selection and capacity of an add-on never change
--     (offering_addons_guard): a purchase keeps its basis (SPK-PAY-002), and a change is a
--     retirement and a new add-on. Only the name, the description and the status move, and a
--     retired add-on stays retired;
--   * an add-on is never deleted (forbid_mutation on delete): selections and quote lines name it.

create table offering_addons (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  offering_id uuid not null,
  code text not null check (code ~ '^[a-z0-9_]{1,50}$'),
  name text not null check (length(name) between 1 and 120),
  description text,
  price_minor bigint not null check (price_minor >= 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  charge_lines jsonb not null default '[]'::jsonb,
  selection text not null default 'per_registration'
    check (selection in ('per_registration', 'per_session')),
  capacity integer check (capacity >= 0),
  status text not null default 'active' check (status in ('active', 'retired')),
  retired_at timestamptz,
  created_by jsonb not null,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, offering_id, id),
  foreign key (organization_id, offering_id) references offerings (organization_id, id),
  constraint offering_addons_retired_fact check ((status = 'retired') = (retired_at is not null))
);
create unique index offering_addons_live_code_idx
  on offering_addons (organization_id, offering_id, code) where status = 'active';
create index offering_addons_offering_idx on offering_addons (organization_id, offering_id, created_at);
create trigger offering_addons_touch before update on offering_addons
  for each row execute function touch_updated_at();

create or replace function offering_addons_guard() returns trigger
language plpgsql as $$
begin
  if new.offering_id <> old.offering_id
     or new.code <> old.code
     or new.price_minor <> old.price_minor
     or new.currency <> old.currency
     or new.charge_lines is distinct from old.charge_lines
     or new.selection <> old.selection
     or new.capacity is distinct from old.capacity then
    raise exception 'add-on % is immutable; retire it and create a new one', old.id
      using errcode = 'restrict_violation';
  end if;
  if old.status = 'retired' and new.status <> 'retired' then
    raise exception 'add-on % is retired', old.id using errcode = 'restrict_violation';
  end if;
  return new;
end
$$;
create trigger offering_addons_guard before update on offering_addons
  for each row execute function offering_addons_guard();
create trigger offering_addons_no_delete before delete on offering_addons
  for each row execute function forbid_mutation();
