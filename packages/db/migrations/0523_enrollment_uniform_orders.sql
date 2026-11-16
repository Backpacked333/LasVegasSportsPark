-- 0523_enrollment_uniform_orders.sql
-- Enrollment module. Proposed amendment PA-07 (SPK-REG-012, uniform purchase during
-- registration); Proposed, open values Pending decision (DEC-101). Capability uniforms.
--
-- basket_line_uniforms: the uniform and size chosen for a basket line (one per line and
-- participant). uniform_orders: the uniform ordered with the registration the line became, with
-- its lifecycle (UniformOrderMachine in packages/contracts/src/state-machines.ts): ordered while
-- the registration is pending, paid when it is confirmed, handed over by a staff command,
-- canceled with a registration that ended before the hand-over. uniform_handover_events: the
-- append-only record of every hand-over (who, when) and of every correction that undid one.
--
-- Invariants enforced here (the enrollment service checks the same first):
--   * the chosen uniform is a uniform of the line's own offering and organization, and the size
--     is one of its sizes (composite foreign key and basket_line_uniforms_guard);
--   * one uniform choice per basket line; a choice is never rewritten, and is removed only with
--     its line while the line is still pending;
--   * one live (not canceled) uniform order per participant and offering
--     (uniform_orders_live_idx), and one order per enrollment;
--   * the order's status moves only as the machine allows (uniform_orders_machine), each status
--     carries exactly its facts (…_paid_fact, …_handed_over_fact, …_canceled_fact), and what was
--     ordered never changes (uniform_orders_basis_immutable);
--   * an order is handed over only with a hand-over event that no correction has undone, and
--     leaves handed over only when every hand-over event has its correction
--     (uniform_orders_hand_over_recorded): a hand-over is undone by a recorded correction only;
--   * hand-over events are append-only (forbid_mutation): never rewritten, never deleted; a
--     correction names the hand-over of the same order it undoes, carries a reason, and a
--     hand-over is corrected at most once;
--   * every reference stays inside the organization (composite foreign keys, §4.3).

create table basket_line_uniforms (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  basket_line_id uuid not null,
  offering_id uuid not null,
  offering_uniform_id uuid not null,
  size text not null check (length(size) between 1 and 30),
  created_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, basket_line_id),
  foreign key (organization_id, basket_line_id)
    references basket_lines (organization_id, id) on delete cascade,
  constraint basket_line_uniforms_uniform_fk
    foreign key (organization_id, offering_id, offering_uniform_id)
    references offering_uniforms (organization_id, offering_id, id)
);

create or replace function basket_line_uniforms_guard() returns trigger
language plpgsql as $$
declare
  line_offering uuid;
begin
  if tg_op = 'UPDATE' then
    raise exception 'a uniform choice is never rewritten'
      using errcode = 'restrict_violation';
  end if;
  if tg_op = 'DELETE' then
    if exists (
      select 1 from basket_lines bl
       where bl.organization_id = old.organization_id
         and bl.id = old.basket_line_id
         and bl.outcome <> 'pending'
    ) then
      raise exception 'the uniform choice of a decided basket line is kept'
        using errcode = 'restrict_violation';
    end if;
    return old;
  end if;
  select bl.offering_id into line_offering
    from basket_lines bl
   where bl.organization_id = new.organization_id and bl.id = new.basket_line_id;
  if line_offering is distinct from new.offering_id then
    raise exception 'uniform % is not a uniform of the offering of line %', new.offering_uniform_id, new.basket_line_id
      using errcode = 'check_violation', constraint = 'basket_line_uniforms_offering_of_line';
  end if;
  if not exists (
    select 1
      from offering_uniforms u, jsonb_array_elements_text(u.sizes) as s(size)
     where u.organization_id = new.organization_id
       and u.id = new.offering_uniform_id
       and s.size = new.size
  ) then
    raise exception 'size % is not a size of uniform %', new.size, new.offering_uniform_id
      using errcode = 'check_violation', constraint = 'basket_line_uniforms_size_offered';
  end if;
  return new;
end
$$;
create trigger basket_line_uniforms_guard before insert or update or delete on basket_line_uniforms
  for each row execute function basket_line_uniforms_guard();

create table uniform_orders (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  enrollment_id uuid not null,
  basket_line_id uuid,
  offering_id uuid not null,
  offering_uniform_id uuid not null,
  team_entry_id uuid,                                 -- the team entry of a join_team registration
  participant_person_id uuid not null,
  item_key text not null,
  name text not null,
  size text not null,
  price_minor bigint check (price_minor >= 0),        -- the uniform's price when ordered; null = not charged
  currency text check (currency ~ '^[A-Z]{3}$'),
  status text not null default 'ordered' check (status in ('ordered', 'paid', 'handed_over', 'canceled')),
  ordered_at timestamptz not null,
  paid_at timestamptz,
  handed_over_at timestamptz,
  handed_over_by jsonb,                               -- actor snapshot of the staff member
  handed_over_by_person_id uuid,
  canceled_at timestamptz,
  cancel_reason text,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, enrollment_id),
  foreign key (organization_id, enrollment_id) references enrollments (organization_id, id),
  foreign key (organization_id, basket_line_id) references basket_lines (organization_id, id),
  constraint uniform_orders_uniform_fk
    foreign key (organization_id, offering_id, offering_uniform_id)
    references offering_uniforms (organization_id, offering_id, id),
  foreign key (organization_id, team_entry_id) references team_entries (organization_id, id),
  foreign key (organization_id, participant_person_id) references persons (organization_id, id),
  foreign key (organization_id, handed_over_by_person_id) references persons (organization_id, id),
  constraint uniform_orders_price_complete check ((price_minor is null) = (currency is null)),
  constraint uniform_orders_paid_fact
    check (status not in ('paid', 'handed_over') or paid_at is not null),
  constraint uniform_orders_handed_over_fact
    check ((status = 'handed_over') = (handed_over_at is not null and handed_over_by is not null)),
  constraint uniform_orders_canceled_fact check ((status = 'canceled') = (canceled_at is not null))
);
-- A second live uniform for the same participant and offering is refused.
create unique index uniform_orders_live_idx
  on uniform_orders (organization_id, participant_person_id, offering_id)
  where status <> 'canceled';
create index uniform_orders_offering_idx on uniform_orders (organization_id, offering_id, status);
create index uniform_orders_team_entry_idx on uniform_orders (organization_id, team_entry_id)
  where team_entry_id is not null;
create index uniform_orders_holder_idx
  on uniform_orders (organization_id, participant_person_id, item_key)
  where status = 'handed_over';
create trigger uniform_orders_touch before update on uniform_orders
  for each row execute function touch_updated_at();

create table uniform_handover_events (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  uniform_order_id uuid not null,
  kind text not null check (kind in ('handed_over', 'correction')),
  corrects_event_id uuid,
  reason text,
  actor jsonb not null,                               -- who handed it over, or who corrected
  actor_person_id uuid,
  occurred_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, uniform_order_id, id),
  foreign key (organization_id, uniform_order_id) references uniform_orders (organization_id, id),
  -- A correction undoes a hand-over of the same order.
  constraint uniform_handover_events_corrects_fk
    foreign key (organization_id, uniform_order_id, corrects_event_id)
    references uniform_handover_events (organization_id, uniform_order_id, id),
  foreign key (organization_id, actor_person_id) references persons (organization_id, id),
  constraint uniform_handover_events_correction_shape
    check ((kind = 'correction') = (corrects_event_id is not null)),
  constraint uniform_handover_events_correction_reason
    check (kind <> 'correction' or (reason is not null and length(btrim(reason)) >= 3))
);
-- A hand-over is corrected at most once.
create unique index uniform_handover_events_corrected_once_idx
  on uniform_handover_events (organization_id, corrects_event_id)
  where corrects_event_id is not null;
create index uniform_handover_events_order_idx
  on uniform_handover_events (organization_id, uniform_order_id, occurred_at);

create or replace function uniform_handover_events_guard() returns trigger
language plpgsql as $$
begin
  if new.kind = 'correction' and not exists (
    select 1 from uniform_handover_events e
     where e.organization_id = new.organization_id
       and e.id = new.corrects_event_id
       and e.kind = 'handed_over'
  ) then
    raise exception 'a correction undoes a hand-over, not another correction'
      using errcode = 'check_violation', constraint = 'uniform_handover_events_corrects_hand_over';
  end if;
  return new;
end
$$;
create trigger uniform_handover_events_guard before insert on uniform_handover_events
  for each row execute function uniform_handover_events_guard();
create trigger uniform_handover_events_append_only before update or delete on uniform_handover_events
  for each row execute function forbid_mutation();

create or replace function uniform_orders_guard() returns trigger
language plpgsql as $$
declare
  open_hand_overs integer;
begin
  if new.enrollment_id <> old.enrollment_id
     or new.offering_id <> old.offering_id
     or new.offering_uniform_id <> old.offering_uniform_id
     or new.participant_person_id <> old.participant_person_id
     or new.item_key <> old.item_key
     or new.size <> old.size
     or new.price_minor is distinct from old.price_minor
     or new.currency is distinct from old.currency
     or new.ordered_at <> old.ordered_at then
    raise exception 'what uniform order % ordered is immutable', old.id
      using errcode = 'check_violation', constraint = 'uniform_orders_basis_immutable';
  end if;
  if new.status = old.status then
    return new;
  end if;
  if not (
    (old.status = 'ordered' and new.status in ('paid', 'canceled'))
    or (old.status = 'paid' and new.status in ('handed_over', 'canceled'))
    or (old.status = 'handed_over' and new.status = 'paid')
  ) then
    raise exception 'uniform order % cannot move from % to %', old.id, old.status, new.status
      using errcode = 'check_violation', constraint = 'uniform_orders_machine';
  end if;
  select count(*) into open_hand_overs
    from uniform_handover_events h
   where h.organization_id = old.organization_id
     and h.uniform_order_id = old.id
     and h.kind = 'handed_over'
     and not exists (
       select 1 from uniform_handover_events c
        where c.organization_id = h.organization_id and c.corrects_event_id = h.id
     );
  if (new.status = 'handed_over' and open_hand_overs <> 1)
     or (old.status = 'handed_over' and open_hand_overs <> 0) then
    raise exception 'uniform order % changes its hand-over only with a recorded hand-over or correction', old.id
      using errcode = 'check_violation', constraint = 'uniform_orders_hand_over_recorded';
  end if;
  return new;
end
$$;
create trigger uniform_orders_guard before update on uniform_orders
  for each row execute function uniform_orders_guard();
create trigger uniform_orders_no_delete before delete on uniform_orders
  for each row execute function forbid_mutation();
