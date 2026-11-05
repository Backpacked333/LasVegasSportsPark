-- 0205_catalog_package_g_definitions.sql
-- Catalog module, CAT-02: Package G definitions (§3.16, §6.5 Package G; SPK-CAT-002,
-- SPK-COND-001 to SPK-COND-003). Whether the complex uses memberships, session packages, rentals,
-- parties or pickup sessions is pending (DEC-016 and DEC-072, DEC-074, DEC-076, DEC-077, DEC-082);
-- the catalog commands that create those offerings check the organization's capability switch.
-- This migration only adds the vocabulary and the integrity rules; it invents no policy value.
--
--   * offerings.kind gains 'party' (each party package is its own party offering);
--   * entitlement_definitions.kind gains 'party_package';
--   * policy_versions.kind gains 'booking_terms' and 'tax_fee' (financial kinds, approved by the
--     finance operator: POL-005, POL-040, DEC-057);
--   * offerings.booking_terms_key names the booking_terms policy family of a rental or party
--     offering; such an offering cannot leave draft without it (archiving a draft stays possible);
--   * a typed entitlement scope must carry every key its kind requires (the catalog service
--     validates the full shape; the database refuses a row that omits an effect). A membership
--     benefit names its attendance effect explicitly: 'unlimited' is only ever a stated choice
--     (SPK-COND-001). Each check is wrapped in coalesce(..., false) because a missing key reads
--     as null, and a check constraint that evaluates to null passes.

alter table offerings drop constraint offerings_kind_check;
alter table offerings add constraint offerings_kind_check check (kind in (
  'season', 'term', 'camp', 'session', 'trial', 'makeup', 'pickup', 'private_coaching', 'rental',
  'package', 'membership', 'party'
));

alter table entitlement_definitions drop constraint entitlement_definitions_kind_check;
alter table entitlement_definitions add constraint entitlement_definitions_kind_check check (kind in (
  'team_entry', 'roster_place', 'seat', 'session_seat', 'camp_group_place', 'rental_resource',
  'package_credits', 'membership_benefit', 'party_package'
));

alter table policy_versions drop constraint policy_versions_kind_check;
alter table policy_versions add constraint policy_versions_kind_check check (kind in (
  'eligibility', 'cancellation', 'refund', 'discount', 'waitlist', 'hold', 'approval', 'form',
  'overpayment', 'installment', 'booking_terms', 'tax_fee'
));

-- The booking terms family (policy kind booking_terms, same key format as policy_versions.key).
-- The approved version effective at an instant is resolved when the offering is read, so a new
-- approved version of the terms applies without editing the offering.
alter table offerings add column booking_terms_key text;
alter table offerings add constraint offerings_booking_terms_key_format
  check (booking_terms_key is null or booking_terms_key ~ '^[a-z0-9][a-z0-9_-]{0,99}$');
alter table offerings add constraint offerings_booking_terms_only_for_bookings
  check (booking_terms_key is null or kind in ('rental', 'party'));
alter table offerings add constraint offerings_booking_terms_required
  check (
    kind not in ('rental', 'party')
    or booking_terms_key is not null
    or publication_state in ('draft', 'archived')
  );

-- SPK-COND-001: a membership benefit states its attendance effect ('none', 'included_sessions'
-- or 'unlimited'), its term and its renewal; nothing is implied.
alter table entitlement_definitions add constraint entitlement_definitions_membership_benefit_scope
  check (
    kind <> 'membership_benefit' or coalesce((
      jsonb_typeof(scope->'attendance') = 'object'
      and scope->'attendance'->>'mode' in ('none', 'included_sessions', 'unlimited')
      and jsonb_typeof(scope->'term') = 'object'
      and scope->'term'->>'kind' in ('offering_dates', 'from_confirmation')
      and jsonb_typeof(scope->'renewal') = 'object'
      and (scope->'renewal') ? 'noticeLeadDays'
    ), false)
  );

-- SPK-COND-002: a package states its credits, what they apply to and its expiry choice.
alter table entitlement_definitions add constraint entitlement_definitions_package_credits_scope
  check (
    kind <> 'package_credits' or coalesce((
      case
        when jsonb_typeof(scope->'credits') = 'number' then (scope->>'credits')::numeric >= 1
        else false
      end
      and jsonb_typeof(scope->'appliesTo') = 'object'
      and jsonb_typeof(scope->'expiry') = 'object'
      and scope->'expiry'->>'kind' in ('none', 'days_after_issue', 'fixed_date')
    ), false)
  );

-- SPK-COND-003: a party package names its duration, guest limit, resources, staffing (possibly
-- none) and equipment together, so a booking can reserve all of them at once.
alter table entitlement_definitions add constraint entitlement_definitions_party_package_scope
  check (
    kind <> 'party_package' or coalesce((
      jsonb_typeof(scope->'durationMinutes') = 'number'
      and jsonb_typeof(scope->'guestLimit') = 'number'
      and jsonb_typeof(scope->'resources') = 'object'
      and jsonb_typeof(scope->'staffing') = 'array'
      and jsonb_typeof(scope->'equipmentAssetIds') = 'array'
    ), false)
  );

-- SPK-COND-003: a rental names the resources it reserves and its staffing (possibly none).
alter table entitlement_definitions add constraint entitlement_definitions_rental_resource_scope
  check (
    kind <> 'rental_resource' or coalesce((
      jsonb_typeof(scope->'resources') = 'object'
      and jsonb_typeof(scope->'staffing') = 'array'
    ), false)
  );
