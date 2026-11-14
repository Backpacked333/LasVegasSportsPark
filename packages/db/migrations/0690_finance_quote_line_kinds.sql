-- 0690_finance_quote_line_kinds.sql
-- Finance module. Proposed amendments PA-03 (SPK-PAY-014, add-ons) and PA-07 (SPK-REG-012,
-- uniforms); both Proposed, open values Pending decision (DEC-097, DEC-101). ADR-003: extras are
-- their own lines of the basket line they belong to.
--
-- A quote line gains line_kind ('registration': the place itself, every existing row; 'addon';
-- 'uniform') and source_id (the add-on or the offering uniform of an extra line). Extra lines
-- carry the same basket line and enrollment as the place, so order, receipt, refund and
-- reporting travel with the registration.
--
-- The uniqueness of 0600, unique (quote_id, basket_line_id), allowed exactly one quote line per
-- basket line. It is deliberately widened, not dropped: a basket line still has at most one
-- registration line per quote (quote_lines_one_registration_idx), and at most one line per
-- add-on or uniform (quote_lines_one_per_source_idx), so neither the place nor an extra can be
-- charged twice in one quote.
--
-- quote_lines is append-only (0600): only constraints change here; no row is rewritten.
--
-- Invariants enforced here:
--   * line_kind is one of the three kinds; the place names no source and an extra names one
--     (quote_lines_source_shape);
--   * the source of an extra line is an add-on, or a uniform, of the line's own offering and
--     organization (trigger quote_lines_source_guard; source_id points at one of two tables, so
--     it cannot be a plain foreign key);
--   * an extra line always stores its basis (quote_lines_extra_basis), and 0687 already makes a
--     stored basis state the line's unit price, so the amount of an add-on or uniform line can be
--     reproduced from stored facts (SPK-PAY-002);
--   * the two checks that tied a price to a price rule now apply to the place only: an add-on or
--     a uniform is priced by its own record, named by source_id (quote_lines_priced,
--     quote_lines_price_basis_priced).

alter table quote_lines
  add column line_kind text not null default 'registration'
    constraint quote_lines_line_kind_check check (line_kind in ('registration', 'addon', 'uniform')),
  add column source_id uuid;

alter table quote_lines
  add constraint quote_lines_source_shape
    check ((line_kind = 'registration') = (source_id is null)),
  add constraint quote_lines_extra_basis
    check (line_kind = 'registration' or price_basis is not null);

alter table quote_lines drop constraint quote_lines_priced;
alter table quote_lines add constraint quote_lines_priced
  check (line_kind <> 'registration' or price_rule_id is not null or unit_price_minor = 0);

alter table quote_lines drop constraint quote_lines_price_basis_priced;
alter table quote_lines add constraint quote_lines_price_basis_priced
  check (line_kind <> 'registration' or price_basis is null or price_rule_id is not null);

alter table quote_lines drop constraint quote_lines_quote_id_basket_line_id_key;
create unique index quote_lines_one_registration_idx
  on quote_lines (quote_id, basket_line_id) where line_kind = 'registration';
create unique index quote_lines_one_per_source_idx
  on quote_lines (quote_id, basket_line_id, line_kind, source_id) where line_kind <> 'registration';

create or replace function quote_lines_source_guard() returns trigger
language plpgsql as $$
begin
  if new.line_kind = 'addon' and not exists (
    select 1 from offering_addons a
     where a.organization_id = new.organization_id
       and a.offering_id = new.offering_id
       and a.id = new.source_id
  ) then
    raise exception 'quote line % names no add-on of its offering', new.id
      using errcode = 'foreign_key_violation', constraint = 'quote_lines_source_guard';
  end if;
  if new.line_kind = 'uniform' and not exists (
    select 1 from offering_uniforms u
     where u.organization_id = new.organization_id
       and u.offering_id = new.offering_id
       and u.id = new.source_id
  ) then
    raise exception 'quote line % names no uniform of its offering', new.id
      using errcode = 'foreign_key_violation', constraint = 'quote_lines_source_guard';
  end if;
  return new;
end
$$;
create trigger quote_lines_source_guard before insert on quote_lines
  for each row execute function quote_lines_source_guard();
