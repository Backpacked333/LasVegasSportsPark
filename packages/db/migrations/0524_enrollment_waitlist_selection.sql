-- 0524_enrollment_waitlist_selection.sql
-- Enrollment module. Proposed amendments PA-03 (SPK-PAY-014, capability price_tiers_addons) and
-- PA-07 (SPK-REG-012, capability uniforms); Proposed, open values Pending decision (DEC-097,
-- DEC-101). Quality review finding M-2.
--
-- A waitlist entry of an offering records what it waits for beyond a place: the price tier, the
-- sessions of a tier of chosen days (null means every session, as on a basket line), and the
-- add-ons and uniform asked for (requested_extras). The entry waits on the capacity pools that
-- selection needs (the sessions' pools, an add-on's own pool), an offer holds a place in each,
-- and accepting opens a basket line that carries the same choices, so its quote prices the tier
-- and the place that was held can be paid. Every entry written before this migration has none of
-- them and waits for a place of the offering as before.
--
-- Invariants enforced here (the enrollment service checks the same first):
--   * the tier is a tier of the entry's own offering and organization (composite foreign key over
--     organization, offering and tier: waitlist_entries_price_tier_fk);
--   * a day selection needs a tier (waitlist_entries_selection_needs_tier), is not empty, lists
--     each session once and only sessions of the entry's offering (registration_selection_guard,
--     the trigger function of 0521);
--   * a session queue (pickup, trial) waits for its session and nothing else
--     (waitlist_entries_selection_offering_queue);
--   * requested_extras is an object with a list of add-ons (waitlist_entries_requested_extras_shape);
--     what each add-on and the uniform are is validated against the catalog when the entry is
--     written and again when an offer is accepted, where the basket line's own guards apply;
--   * what an entry waits for never changes after it is written (waitlist_entries_request_immutable):
--     a different tier or other days is a withdrawal and a new entry at the end of the queue.

alter table waitlist_entries
  add column price_tier_id uuid,
  add column selected_session_ids uuid[],
  add column requested_extras jsonb,
  add constraint waitlist_entries_price_tier_fk
    foreign key (organization_id, offering_id, price_tier_id)
    references price_rule_tiers (organization_id, offering_id, id),
  add constraint waitlist_entries_selection_needs_tier
    check (selected_session_ids is null or price_tier_id is not null),
  add constraint waitlist_entries_selection_offering_queue
    check (session_id is null
           or (price_tier_id is null and selected_session_ids is null and requested_extras is null)),
  add constraint waitlist_entries_requested_extras_shape
    check (requested_extras is null
           or (jsonb_typeof(requested_extras) = 'object'
               and coalesce(jsonb_typeof(requested_extras -> 'addons'), '') = 'array'));

create trigger waitlist_entries_selection_guard
  before insert or update of selected_session_ids, offering_id on waitlist_entries
  for each row execute function registration_selection_guard();

create or replace function waitlist_entries_request_immutable() returns trigger
language plpgsql as $$
begin
  if new.price_tier_id is distinct from old.price_tier_id
     or new.selected_session_ids is distinct from old.selected_session_ids
     or new.requested_extras is distinct from old.requested_extras then
    raise exception 'what waitlist entry % waits for cannot be changed', old.id
      using errcode = 'check_violation', constraint = 'waitlist_entries_request_immutable';
  end if;
  return new;
end
$$;
create trigger waitlist_entries_request_immutable
  before update of price_tier_id, selected_session_ids, requested_extras on waitlist_entries
  for each row execute function waitlist_entries_request_immutable();

-- Offer generation finds the entries that wait for an add-on's pool by the add-on's id.
create index waitlist_entries_requested_extras_idx
  on waitlist_entries using gin (requested_extras jsonb_path_ops)
  where requested_extras is not null and status = 'waiting';
