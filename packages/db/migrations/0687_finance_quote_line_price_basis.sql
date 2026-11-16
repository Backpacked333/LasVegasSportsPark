-- 0687_finance_quote_line_price_basis.sql
-- Finance module. Proposed amendments PA-02 (SPK-PAY-013) and PA-04 (SPK-PAY-015), both Proposed
-- with open values Pending decision (DEC-096, DEC-098).
--
-- SPK-PAY-002: a quote must remain reproducible later from stored facts. When a line's unit price
-- is worked out from more than the price rule's base price (a per-session price times the sessions
-- still to attend, or a member price that applied because of a membership held at the quote
-- instant), the facts used are stored with the line: the sessions counted and when, whether the
-- member price applied and why, and the unit price that results. A line priced the way it always
-- was (a plain term price) carries no basis: the column is null, as for every existing row.
--
-- Quote lines stay append-only (0600): the basis is written with the line and never changed.
-- quantity stays the basket quantity and quote_lines_base_consistent (base = unit x quantity)
-- stays as it is; the multiplication by sessions is inside the unit price and explained here.
-- Order lines already carry price_basis (0600); the checkout copies this document into it.
--
-- Invariants enforced here:
--   * a basis is a JSON object that states the unit price of its line
--     (quote_lines_price_basis_unit_price), so a stored explanation can never disagree with the
--     amount charged;
--   * a basis is the explanation of a priced line (quote_lines_price_basis_priced).

alter table quote_lines add column price_basis jsonb;

-- CASE keeps the ->> cast away from values of another JSON type (the order in which the
-- conditions of a plain AND are evaluated is not guaranteed).
alter table quote_lines add constraint quote_lines_price_basis_unit_price check (
  case
    when price_basis is null then true
    when jsonb_typeof(price_basis) <> 'object' then false
    when jsonb_typeof(price_basis->'unitPriceMinor') is distinct from 'number' then false
    else (price_basis->>'unitPriceMinor')::numeric = unit_price_minor
  end
);

alter table quote_lines add constraint quote_lines_price_basis_priced check (
  price_basis is null or price_rule_id is not null
);
