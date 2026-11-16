-- 0522_enrollment_basket_line_addons.sql
-- Enrollment module. Proposed amendment PA-03 (SPK-PAY-014); Proposed, open values Pending
-- decision (DEC-097). Capability price_tiers_addons.
--
-- The add-ons selected for a basket line (catalog 0216): one row for an add-on selected once for
-- the registration (session_id null), one row per session for an add-on selected per session.
-- The rows travel with the line and, through it, with the enrollment the line becomes, so the
-- attendance list of a day can show the add-ons bought for that day, and the add-on is refunded,
-- transferred and reported with its registration.
--
-- Add-on capacity is its own pool: capacity_pools gains the scope 'addon' (scope_id is the
-- add-on; scope_session_id the session, for an add-on limited per session). The pool is held and
-- committed like any other, so capacity_pools_within_capacity (committed + held <= capacity) is
-- the guarantee that an add-on is never oversold, under concurrency too (§4.7 invariant 3).
--
-- Invariants enforced here (the enrollment service checks the same first):
--   * the add-on is an add-on of the line's own offering and organization (composite foreign key
--     over organization, offering and add-on, and basket_line_addons_offering_of_line);
--   * an add-on selected per session names a session, and that session is one the participant
--     attends: a session of the offering that is in the line's day selection when the line has
--     one (basket_line_addons_session_selected). An add-on selected per registration names no
--     session (basket_line_addons_selection_shape);
--   * an add-on is selected once per line (and once per session of a line);
--   * a selection is never rewritten, and is removed only with its line while the line is still
--     pending (basket_line_addons_guard);
--   * an add-on pool belongs to an add-on of its organization (capacity_pools_addon_scope_guard);
--     only an add-on pool names a session scope.

create table basket_line_addons (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  basket_line_id uuid not null,
  offering_id uuid not null,
  addon_id uuid not null,
  session_id uuid,
  created_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, basket_line_id)
    references basket_lines (organization_id, id) on delete cascade,
  constraint basket_line_addons_addon_fk
    foreign key (organization_id, offering_id, addon_id)
    references offering_addons (organization_id, offering_id, id),
  foreign key (organization_id, session_id) references offering_sessions (organization_id, id)
);
create unique index basket_line_addons_once_idx
  on basket_line_addons (organization_id, basket_line_id, addon_id) where session_id is null;
create unique index basket_line_addons_once_per_session_idx
  on basket_line_addons (organization_id, basket_line_id, addon_id, session_id)
  where session_id is not null;
create index basket_line_addons_line_idx on basket_line_addons (organization_id, basket_line_id);
create index basket_line_addons_session_idx on basket_line_addons (organization_id, session_id)
  where session_id is not null;

create or replace function basket_line_addons_guard() returns trigger
language plpgsql as $$
declare
  line record;
  addon_selection text;
begin
  if tg_op = 'UPDATE' then
    raise exception 'an add-on selection is never rewritten'
      using errcode = 'restrict_violation';
  end if;
  if tg_op = 'DELETE' then
    -- Removed with its line (the cascade runs after the line is gone); never from a line that
    -- is held, confirmed or otherwise decided.
    if exists (
      select 1 from basket_lines bl
       where bl.organization_id = old.organization_id
         and bl.id = old.basket_line_id
         and bl.outcome <> 'pending'
    ) then
      raise exception 'the add-ons of a decided basket line are kept'
        using errcode = 'restrict_violation';
    end if;
    return old;
  end if;
  select bl.offering_id, bl.selected_session_ids into line
    from basket_lines bl
   where bl.organization_id = new.organization_id and bl.id = new.basket_line_id;
  if line.offering_id is distinct from new.offering_id then
    raise exception 'add-on % is not an add-on of the offering of line %', new.addon_id, new.basket_line_id
      using errcode = 'check_violation', constraint = 'basket_line_addons_offering_of_line';
  end if;
  select a.selection into addon_selection
    from offering_addons a
   where a.organization_id = new.organization_id and a.id = new.addon_id;
  if (addon_selection = 'per_session') <> (new.session_id is not null) then
    raise exception 'add-on % is selected %', new.addon_id, replace(addon_selection, '_', ' ')
      using errcode = 'check_violation', constraint = 'basket_line_addons_selection_shape';
  end if;
  if new.session_id is not null then
    if not exists (
      select 1 from offering_sessions os
       where os.organization_id = new.organization_id
         and os.offering_id = new.offering_id
         and os.id = new.session_id
    ) or (line.selected_session_ids is not null
          and not (new.session_id = any (line.selected_session_ids))) then
      raise exception 'session % is not one the participant of line % attends', new.session_id, new.basket_line_id
        using errcode = 'check_violation', constraint = 'basket_line_addons_session_selected';
    end if;
  end if;
  return new;
end
$$;
create trigger basket_line_addons_guard before insert or update or delete on basket_line_addons
  for each row execute function basket_line_addons_guard();

-- ---------------------------------------------------------------------------------------------
-- Add-on capacity pools
-- ---------------------------------------------------------------------------------------------

alter table capacity_pools drop constraint capacity_pools_scope_type_check;
alter table capacity_pools add constraint capacity_pools_scope_type_check
  check (scope_type in ('offering', 'session', 'division', 'team_entry', 'camp_group', 'rental', 'addon'));

alter table capacity_pools
  add column scope_session_id uuid,
  add constraint capacity_pools_scope_session_fk
    foreign key (organization_id, scope_session_id) references offering_sessions (organization_id, id),
  add constraint capacity_pools_scope_session_addon_only
    check (scope_session_id is null or scope_type = 'addon');

-- One pool per scope, unit and constraint kind, as before; an add-on limited per session has one
-- pool per session. The unique constraint of 0500 is replaced by a unique index that includes the
-- session scope (the constraint is found by its definition, because its generated name is cut to
-- the identifier length).
do $$
declare
  existing text;
begin
  select conname into existing
    from pg_constraint
   where conrelid = 'capacity_pools'::regclass
     and contype = 'u'
     and pg_get_constraintdef(oid) = 'UNIQUE (organization_id, scope_type, scope_id, unit, constraint_kind)';
  if existing is null then
    raise exception 'the capacity pool scope uniqueness of 0500 was not found';
  end if;
  execute format('alter table capacity_pools drop constraint %I', existing);
end
$$;
create unique index capacity_pools_scope_idx on capacity_pools (
  organization_id, scope_type, scope_id, unit, constraint_kind,
  coalesce(scope_session_id, '00000000-0000-0000-0000-000000000000'::uuid)
);

create or replace function capacity_pools_addon_scope_guard() returns trigger
language plpgsql as $$
begin
  if new.scope_type = 'addon' and not exists (
    select 1 from offering_addons a
     where a.organization_id = new.organization_id and a.id = new.scope_id
  ) then
    raise exception 'capacity pool % names no add-on of its organization', new.id
      using errcode = 'foreign_key_violation', constraint = 'capacity_pools_addon_scope_guard';
  end if;
  return new;
end
$$;
create trigger capacity_pools_addon_scope_guard
  before insert or update of scope_type, scope_id, organization_id on capacity_pools
  for each row execute function capacity_pools_addon_scope_guard();
