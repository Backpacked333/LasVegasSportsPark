-- 0211_catalog_price_rule_basis_and_member_price.sql
-- Catalog module. Proposed amendments PA-02 (SPK-PAY-013, class price by sessions remaining) and
-- PA-04 (SPK-PAY-015, member and non-member price on one offering); both are Proposed and their
-- open values are Pending decision (DEC-096, DEC-098). The behaviour is switched per organization
-- by the capabilities per_session_pricing and member_pricing (core migration 0020); this migration
-- only makes the price rule able to state it.
--
-- The price rule stays the single source of an offering's price: the exclusion constraint
-- price_rules_one_effective_per_instant (0200) is untouched, so one rule is still effective per
-- offering per instant. A rule gains:
--   * pricing_basis: 'term' (base_price_minor is the price of joining; every existing row) or
--     'per_session' (base_price_minor is the price of one session);
--   * member_price_minor and member_entitlement_definition_id: the price for a participant who
--     holds that membership entitlement, on the same basis as base_price_minor.
--
-- Invariants enforced here (the catalog service checks the same first):
--   * pricing_basis is one of the two known values (price_rules_pricing_basis_check);
--   * a member price and the entitlement it requires are stated together or not at all
--     (price_rules_member_price_complete);
--   * a member price is never negative (price_rules_member_price_minor_check);
--   * the entitlement belongs to the rule's organization (composite foreign key
--     price_rules_member_entitlement_fk, §4.3);
--   * the three columns are pricing content, so they are immutable like the base price
--     (price_rules_guard): a correction is a new version (SPK-PAY-002).
-- Whether the named entitlement is a membership benefit is checked by the service when the rule
-- is written; a rule naming another kind could never apply, because only memberships are read.

alter table price_rules
  add column pricing_basis text not null default 'term'
    constraint price_rules_pricing_basis_check check (pricing_basis in ('term', 'per_session')),
  add column member_price_minor bigint
    constraint price_rules_member_price_minor_check check (member_price_minor >= 0),
  add column member_entitlement_definition_id uuid;

alter table price_rules
  add constraint price_rules_member_price_complete
    check ((member_price_minor is null) = (member_entitlement_definition_id is null)),
  add constraint price_rules_member_entitlement_fk
    foreign key (organization_id, member_entitlement_definition_id)
    references entitlement_definitions (organization_id, id);

create index price_rules_member_entitlement_idx
  on price_rules (organization_id, member_entitlement_definition_id)
  where member_entitlement_definition_id is not null;

-- Pricing content is immutable: the new columns join the base price, currency and charge lines.
create or replace function price_rules_guard() returns trigger
language plpgsql as $$
begin
  if new.offering_id <> old.offering_id
     or new.version <> old.version
     or new.effective_from <> old.effective_from
     or new.base_price_minor <> old.base_price_minor
     or new.currency <> old.currency
     or new.charge_lines is distinct from old.charge_lines
     or new.pricing_basis <> old.pricing_basis
     or new.member_price_minor is distinct from old.member_price_minor
     or new.member_entitlement_definition_id is distinct from old.member_entitlement_definition_id then
    raise exception 'price rule % is immutable; create a new version', old.id
      using errcode = 'restrict_violation';
  end if;
  if old.effective_to is not null and new.effective_to is distinct from old.effective_to
     and (new.effective_to is null or new.effective_to > old.effective_to) then
    raise exception 'price rule % cannot be extended; create a new version', old.id
      using errcode = 'restrict_violation';
  end if;
  return new;
end
$$;
