-- 0217_catalog_offering_uniforms.sql
-- Catalog module. Proposed amendment PA-07 (SPK-REG-012, uniform purchase during registration);
-- Proposed, open values Pending decision (DEC-101: whether ordering moves into registration,
-- whether stock is counted, prices and the returning-player rule). Capability uniforms.
--
-- An offering (a class, a camp, or the league offering of a team season) may require or offer a
-- uniform (kit) with sizes and an optional price. item_key names the kit across offerings: a
-- participant who was handed a uniform with the same key holds the current uniform, and
-- returning_holder_free says whether they are charged again (the proposed default of the design
-- is "not charged where the offering says so"). Stock is not counted; nothing here assumes it.
--
-- Invariants enforced here:
--   * a uniform belongs to an offering of its own organization (composite foreign key, §4.3);
--   * one live uniform per offering (offering_uniforms_live_idx);
--   * a price and its currency are stated together (offering_uniforms_price_complete);
--   * sizes is a non-empty JSON array (offering_uniforms_sizes_shape);
--   * the item key, sizes, price, currency, charge lines and returning-holder rule never change
--     (offering_uniforms_guard): an order keeps its basis (SPK-PAY-002); a change is a retirement
--     and a new uniform. A retired uniform stays retired;
--   * a uniform is never deleted (forbid_mutation on delete).

create table offering_uniforms (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  offering_id uuid not null,
  item_key text not null check (item_key ~ '^[a-z0-9_-]{1,80}$'),
  name text not null check (length(name) between 1 and 120),
  sizes jsonb not null,
  requirement text not null default 'optional' check (requirement in ('required', 'optional')),
  price_minor bigint check (price_minor >= 0),
  currency text check (currency ~ '^[A-Z]{3}$'),
  charge_lines jsonb not null default '[]'::jsonb,
  returning_holder_free boolean not null default false,
  status text not null default 'active' check (status in ('active', 'retired')),
  retired_at timestamptz,
  created_by jsonb not null,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, offering_id, id),
  foreign key (organization_id, offering_id) references offerings (organization_id, id),
  constraint offering_uniforms_price_complete check ((price_minor is null) = (currency is null)),
  constraint offering_uniforms_sizes_shape check (
    case when jsonb_typeof(sizes) = 'array' then jsonb_array_length(sizes) >= 1 else false end
  ),
  constraint offering_uniforms_retired_fact check ((status = 'retired') = (retired_at is not null))
);
create unique index offering_uniforms_live_idx
  on offering_uniforms (organization_id, offering_id) where status = 'active';
create index offering_uniforms_offering_idx on offering_uniforms (organization_id, offering_id, created_at);
create index offering_uniforms_item_key_idx on offering_uniforms (organization_id, item_key);
create trigger offering_uniforms_touch before update on offering_uniforms
  for each row execute function touch_updated_at();

create or replace function offering_uniforms_guard() returns trigger
language plpgsql as $$
begin
  if new.offering_id <> old.offering_id
     or new.item_key <> old.item_key
     or new.sizes is distinct from old.sizes
     or new.price_minor is distinct from old.price_minor
     or new.currency is distinct from old.currency
     or new.charge_lines is distinct from old.charge_lines
     or new.returning_holder_free <> old.returning_holder_free then
    raise exception 'uniform % is immutable; retire it and set a new one', old.id
      using errcode = 'restrict_violation';
  end if;
  if old.status = 'retired' and new.status <> 'retired' then
    raise exception 'uniform % is retired', old.id using errcode = 'restrict_violation';
  end if;
  return new;
end
$$;
create trigger offering_uniforms_guard before update on offering_uniforms
  for each row execute function offering_uniforms_guard();
create trigger offering_uniforms_no_delete before delete on offering_uniforms
  for each row execute function forbid_mutation();
