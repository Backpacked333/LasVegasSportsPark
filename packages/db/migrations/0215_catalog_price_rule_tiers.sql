-- 0215_catalog_price_rule_tiers.sql
-- Catalog module. Proposed amendment PA-03 (SPK-PAY-014, price tiers and add-ons for camps and
-- classes); Proposed, open values Pending decision (DEC-097). Switched per organization by the
-- capability price_tiers_addons (core migration 0020); this migration only makes a price rule
-- able to carry tiers (ADR-003: price variants live on the price rule).
--
-- A tier names what the participant attends and its price:
--   * attendance 'all_sessions': every session of the offering (a full week; or the same
--     sessions at another price, such as a half day);
--   * attendance 'chosen_sessions': between min_sessions and max_sessions sessions that the
--     customer picks (a single day is 1 to 1; max_sessions null is "as many as wanted").
-- price_minor is on the rule's pricing basis (0211): the price of what the tier names for a
-- 'term' rule, the price of one session for a 'per_session' rule. member_price_minor is the
-- tier's price for a holder of the rule's membership entitlement (SPK-PAY-015). available_until
-- is the purchase deadline of the tier (the date of purchase against a deadline).
--
-- Invariants enforced here (the catalog service checks the same first):
--   * a tier belongs to a price rule of its own organization and offering (composite foreign key
--     price_rule_tiers_rule_fk over organization, rule and offering, §4.3);
--   * codes and display positions are unique within a rule;
--   * the session bounds agree with the attendance (price_rule_tiers_attendance_shape);
--   * a tier member price needs the rule's membership entitlement
--     (price_rule_tiers_member_price_needs_entitlement, trigger on insert);
--   * tiers are pricing content, so they are immutable and never deleted, like the rule's base
--     price (forbid_mutation): a correction is a new price rule version (SPK-PAY-002).
-- That exactly one tier applies to a line is decided where the line is written and quoted
-- (enrollment 0521, finance): the line names its tier, and the quote stores it with the facts.

-- A tier is referenced together with its offering, so a basket line can only name a tier of the
-- offering it is for (enrollment 0521).
alter table price_rules
  add constraint price_rules_offering_identity unique (organization_id, id, offering_id);

create table price_rule_tiers (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  price_rule_id uuid not null,
  offering_id uuid not null,
  code text not null check (code ~ '^[a-z0-9_]{1,50}$'),
  name text not null check (length(name) between 1 and 120),
  sequence integer not null check (sequence >= 1),
  attendance text not null check (attendance in ('all_sessions', 'chosen_sessions')),
  min_sessions integer check (min_sessions >= 1),
  max_sessions integer check (max_sessions >= 1),
  price_minor bigint not null check (price_minor >= 0),
  member_price_minor bigint check (member_price_minor >= 0),
  available_until timestamptz,
  created_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, offering_id, id),
  unique (organization_id, price_rule_id, code),
  unique (organization_id, price_rule_id, sequence),
  constraint price_rule_tiers_rule_fk
    foreign key (organization_id, price_rule_id, offering_id)
    references price_rules (organization_id, id, offering_id),
  constraint price_rule_tiers_attendance_shape check (
    (attendance = 'all_sessions' and min_sessions is null and max_sessions is null)
    or (attendance = 'chosen_sessions' and min_sessions is not null
        and (max_sessions is null or max_sessions >= min_sessions))
  )
);
create index price_rule_tiers_rule_idx on price_rule_tiers (organization_id, price_rule_id, sequence);

create or replace function price_rule_tiers_guard() returns trigger
language plpgsql as $$
begin
  if new.member_price_minor is not null and not exists (
    select 1 from price_rules r
     where r.organization_id = new.organization_id
       and r.id = new.price_rule_id
       and r.member_entitlement_definition_id is not null
  ) then
    raise exception 'price rule % names no membership entitlement for a tier member price', new.price_rule_id
      using errcode = 'check_violation',
            constraint = 'price_rule_tiers_member_price_needs_entitlement';
  end if;
  return new;
end
$$;
create trigger price_rule_tiers_guard before insert on price_rule_tiers
  for each row execute function price_rule_tiers_guard();

create trigger price_rule_tiers_immutable before update or delete on price_rule_tiers
  for each row execute function forbid_mutation();
