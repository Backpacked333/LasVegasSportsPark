-- 0909_facilities_release_checklist.sql
-- Facilities module (SPK-FAC-004 "returning a space to service requires an authorized release",
-- SPK-FAC-002 "resolution and inspection").
--
-- A restriction may carry its own release checklist: the concrete things staff confirm before the
-- area goes back into service ("net replaced and tensioned", "area walked, no debris"). Each item
-- records who confirmed it and when. Items are added, confirmed, reopened or removed while the
-- restriction is still open; a released or withdrawn restriction's checklist is history and is
-- never rewritten. A restriction is released only when every item is confirmed: the service
-- refuses the release (ELIGIBILITY_FAILED, details.code checklist_incomplete) and the database
-- refuses the status change, so a concurrent reopen cannot slip past the check.

create table restriction_checklist_items (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  restriction_id uuid not null,
  position integer not null check (position >= 0),
  label text not null check (length(btrim(label)) between 1 and 200),
  created_by jsonb not null,
  completed_at timestamptz,
  completed_by jsonb,
  completion_note text check (completion_note is null or length(completion_note) <= 2000),
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, restriction_id, position),
  foreign key (organization_id, restriction_id) references restrictions (organization_id, id),
  -- a confirmation always names who confirmed it and when
  check ((completed_at is null) = (completed_by is null)),
  check (completed_at is not null or completion_note is null)
);
create index restriction_checklist_items_restriction_idx
  on restriction_checklist_items (organization_id, restriction_id, position);

create trigger restriction_checklist_items_touch before update on restriction_checklist_items
  for each row execute function touch_updated_at();

-- The checklist of a released or withdrawn restriction is history (never added to, changed or
-- removed); an item never moves to another restriction or organization.
create or replace function restriction_checklist_items_guard() returns trigger
language plpgsql as $$
declare
  target record;
  restriction_status text;
begin
  if tg_op = 'DELETE' then
    target := old;
  else
    target := new;
  end if;
  if tg_op = 'UPDATE'
     and (new.organization_id <> old.organization_id
          or new.restriction_id <> old.restriction_id
          or new.created_by is distinct from old.created_by) then
    raise exception 'checklist item % cannot move or change its author', old.id
      using errcode = 'restrict_violation';
  end if;
  select status into restriction_status
    from restrictions
   where organization_id = target.organization_id
     and id = target.restriction_id;
  if restriction_status in ('released', 'withdrawn') then
    raise exception 'the checklist of % restriction % is closed', restriction_status, target.restriction_id
      using errcode = 'restrict_violation';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger restriction_checklist_items_guard
  before insert or update or delete on restriction_checklist_items
  for each row execute function restriction_checklist_items_guard();

-- SPK-FAC-004: a restriction is released only with every checklist item confirmed.
create or replace function restrictions_release_checklist_guard() returns trigger
language plpgsql as $$
begin
  if new.status = 'released' and old.status <> 'released'
     and exists (
       select 1
         from restriction_checklist_items i
        where i.organization_id = new.organization_id
          and i.restriction_id = new.id
          and i.completed_at is null
     ) then
    raise exception 'restriction % has unconfirmed release checklist items', new.id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger restrictions_release_checklist_guard
  before update of status on restrictions
  for each row execute function restrictions_release_checklist_guard();
