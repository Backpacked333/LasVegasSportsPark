-- 0508_enrollment_bookings.sql
-- Enrollment module, ENR-13: rentals and parties with their space, equipment and staff
-- (§3.16 Rentals and Parties rows, SPK-COND-003, SPK-REG-001, SPK-REG-007). Whether the complex
-- offers rentals or parties is pending (DEC-016, DEC-076, DEC-077); the commands that book or
-- approve one check the organization's `rentals` or `parties` capability switch. Booking terms are
-- configuration (POL-040); approval before any reservation is DEC-029 / POL-005.
--
-- A booking is one rental or party: its occurrences reserve scheduling events (the physical
-- guarantee is scheduling's exclusion constraint), its staffing is workforce's must-be-accepted
-- requirements on those events, and its money is an ordinary basket line, hold and enrollment.
-- BookingMachine (enrollment.state-machines.ts) is mirrored by the transition guard below.

create table bookings (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  facility_id uuid not null,
  offering_id uuid not null,
  kind text not null check (kind in ('rental', 'party')),
  basket_id uuid,
  basket_line_id uuid,
  enrollment_id uuid,
  booker_person_id uuid not null,
  status text not null default 'requested' check (status in (
    'requested', 'held', 'awaiting_staff', 'confirmed', 'declined', 'expired', 'canceled', 'completed'
  )),
  first_start timestamptz not null,
  last_end timestamptz not null,
  occurrences jsonb not null default '[]'::jsonb,     -- [{ start, end }] in booking order
  recurrence jsonb,                                   -- the weekly rule of a recurring rental
  scheduling_series_id uuid,
  scheduling_event_ids uuid[] not null default '{}',
  resource_ids uuid[] not null,
  equipment_asset_ids uuid[] not null default '{}',
  guest_count integer check (guest_count is null or guest_count between 1 and 10000),
  booking_terms_policy_version_id uuid not null,
  confirmation_mode text not null check (confirmation_mode in ('instant', 'request')),
  access_conditions text,
  host_responsibilities text,
  staffing jsonb not null default '[]'::jsonb,        -- the requirements declared per event
  pool_id uuid,
  requested_by jsonb not null,
  requested_by_person_id uuid,
  decided_by jsonb,
  decided_by_person_id uuid,
  decided_at timestamptz,
  decision_reason text check (decision_reason is null or length(decision_reason) between 1 and 2000),
  ended_at timestamptz,
  end_reason text check (end_reason is null or length(end_reason) between 1 and 2000),
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  -- One booking per basket line.
  unique (organization_id, basket_line_id),
  foreign key (organization_id, facility_id) references facilities (organization_id, id),
  foreign key (organization_id, offering_id) references offerings (organization_id, id),
  foreign key (organization_id, basket_id) references baskets (organization_id, id),
  foreign key (organization_id, basket_line_id) references basket_lines (organization_id, id),
  foreign key (organization_id, enrollment_id) references enrollments (organization_id, id),
  foreign key (organization_id, booker_person_id) references persons (organization_id, id),
  foreign key (organization_id, booking_terms_policy_version_id) references policy_versions (organization_id, id),
  foreign key (organization_id, pool_id) references capacity_pools (organization_id, id),
  foreign key (organization_id, requested_by_person_id) references persons (organization_id, id),
  foreign key (organization_id, decided_by_person_id) references persons (organization_id, id),
  check (first_start < last_end),
  check (cardinality(resource_ids) >= 1),
  check (jsonb_typeof(occurrences) = 'array' and jsonb_array_length(occurrences) >= 1),
  -- A party states its guests; a rental does not.
  constraint bookings_party_guests check ((kind = 'party') = (guest_count is not null)),
  constraint bookings_recurrence_rental_only check (recurrence is null or kind = 'rental'),
  -- A requested booking reserves nothing: no event, line, hold or enrollment (DEC-029, POL-005).
  constraint bookings_requested_reserves_nothing check (
    status <> 'requested'
    or (cardinality(scheduling_event_ids) = 0 and basket_line_id is null and enrollment_id is null and pool_id is null)
  ),
  -- A held, awaiting or confirmed booking holds its events and its basket line.
  constraint bookings_reservation_fact check (
    status not in ('held', 'awaiting_staff', 'confirmed', 'completed')
    or (cardinality(scheduling_event_ids) >= 1 and basket_line_id is not null)
  ),
  -- Paid states always name the enrollment the payment confirmed.
  constraint bookings_enrollment_fact check (
    status not in ('awaiting_staff', 'confirmed', 'completed') or enrollment_id is not null
  ),
  constraint bookings_ended_fact check ((status in ('declined', 'expired', 'canceled')) = (ended_at is not null)),
  constraint bookings_decision_fact check (status <> 'declined' or (decided_at is not null and decision_reason is not null))
);
create index bookings_facility_start_idx on bookings (organization_id, facility_id, first_start);
create index bookings_booker_idx on bookings (organization_id, booker_person_id, created_at desc, id);
create index bookings_created_idx on bookings (organization_id, created_at desc, id);
create index bookings_enrollment_idx on bookings (organization_id, enrollment_id) where enrollment_id is not null;
create index bookings_live_idx on bookings (organization_id, status, first_start)
  where status in ('requested', 'held', 'awaiting_staff', 'confirmed');
create index bookings_events_idx on bookings using gin (scheduling_event_ids);
create trigger bookings_touch before update on bookings
  for each row execute function touch_updated_at();

-- BookingMachine (§4.6, ENR-10): requested → held | declined | canceled | expired;
-- held → confirmed | awaiting_staff | expired | canceled; awaiting_staff → confirmed | canceled |
-- completed; confirmed → awaiting_staff | canceled | completed; the rest are final.
create or replace function bookings_transition_guard() returns trigger
language plpgsql as $$
begin
  if new.status = old.status then
    return new;
  end if;
  if (old.status = 'requested' and new.status in ('held', 'declined', 'canceled', 'expired'))
     or (old.status = 'held' and new.status in ('confirmed', 'awaiting_staff', 'expired', 'canceled'))
     or (old.status = 'awaiting_staff' and new.status in ('confirmed', 'canceled', 'completed'))
     or (old.status = 'confirmed' and new.status in ('awaiting_staff', 'canceled', 'completed')) then
    return new;
  end if;
  raise exception 'booking % cannot move from % to %', old.id, old.status, new.status
    using errcode = 'check_violation', constraint = 'bookings_machine';
end
$$;
create trigger bookings_transition_guard before update on bookings
  for each row execute function bookings_transition_guard();
