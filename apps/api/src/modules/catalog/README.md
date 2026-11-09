# catalog module

**Owns:** programs, offerings, offering sessions, entitlement definitions, policy versions,
approvals, acknowledgments, price rules, discount definitions, discount redemption counters and
ledger

**Specification:** §3.2 (SPK-CAT-001..004), §3.15 SPK-PAY-001..003 (price rules and discount
definitions; the quote itself belongs to finance), §3.16 and §6.5 Package G (SPK-COND-001..003
catalog definitions for memberships, packages, rentals and parties), §4.4 Catalog + Policies
(PolicyVersion, Acknowledgment, Approval), §4.5 "`Offering.priceCents` must become versioned price
rules and quotes", SPK-REG-002 (versioned eligibility policies and the configured reference date),
SPK-REG-009 ("staff must not falsely sign a guardian acknowledgment"), SPK-SCHED-008 (facility time
zone on every offering view), SPK-YOUTH-001/002 (program kinds, capacity and staffing
configuration), §5.3/§5.4 (program import provenance), §4.7 invariants 2, 5 and 7

**Migration range:** `packages/db/migrations/0200_catalog_core.sql` … `0299`

**Depends on:** identity (`PERSON_DIRECTORY_PORT` for person checks, `AUTHORITY_LOOKUP_PORT` for the
`complete_forms` authority of a signer); kernel `FacilityDirectory` (K-04, IF-03: facility names and
IANA zones; catalog no longer selects the `facilities` table itself) and `CapabilityService` (K-12,
IF-30: Package G capability switches) and scheduling (`EVENT_SCHEDULING_PORT`: reading and
canceling the event behind a session). Consumes `scheduling.event_changed`
(`catalog.follow_scheduling_event`): when the scheduling event that reserves a session's space is
canceled, the linked sessions are canceled too (`catalog.session_canceled`, audit with the closure),
idempotently (SPK-AT-009, **Verified** `apps/api/src/__tests__/journeys/spk-at-009.spec.ts`); on
any other change (moved, resized, or a draft published at times changed while it was a draft), the
linked scheduled sessions take the event's current published times (`catalog.session_retimed`,
R2-JOURNEYS-03, **Verified** `__tests__/session-scheduling-follow.spec.ts`). The other direction,
a session canceled in the catalog, cancels its event through scheduling (R2-JOURNEYS-02, see
"Session lifecycle and the scheduling event"). `SessionsService.sessionsOfSchedulingEvents` (migration `0204` index) lets
enrollment resolve the sessions of affected events.

**Status: implemented** (verified by `apps/api/src/modules/catalog/__tests__` and the unit specs
next to the code: `pricing/discount-evaluator.spec.ts`, `entitlements/equivalence-key.spec.ts`,
`catalog.state-machines.spec.ts`). Statements below are verified unless marked proposed or pending.

## Tables (migrations `0200_catalog_core.sql` … `0209_catalog_package_g_scope_effects.sql`)

| Table                         | Purpose                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `programs`                    | Reusable definitions: name (unique per organization), activity type, format, age band, status `draft/active/archived`, `source` `staff/import` (0206, CAT-03)                                                                                                                                                                                                                        |
| `policy_versions`             | `(kind, key, version)` unique per organization; kinds eligibility, cancellation, refund, discount, waitlist, hold, approval, form, overpayment, installment; `approval_status` `draft/approved/retired`; trigger `policy_versions_guard` makes approved content immutable and an approved window only shorter (0201); approved and retired versions are never deleted (0201)         |
| `approvals`                   | Append-only approval facts (policy versions, offering publications) with actor, reason, details                                                                                                                                                                                                                                                                                      |
| `acknowledgments`             | Subject, policy version, signer, basis `self/guardian`, recorder snapshot and kind, evidence, status; partial unique index on active `(subject, policy version)`; check `acknowledgments_staff_never_signer`; trigger `acknowledgments_guard` (0202) refuses rewriting signer, basis, recorder, `signed_at` or evidence and reopening a withdrawal, `forbid_mutation` refuses delete |
| `entitlement_definitions`     | Kind (team_entry, roster_place, seat, session_seat, camp_group_place, rental_resource, package_credits, membership_benefit, party_package), scope, `equivalence_scope` + rule used by enrollment for §4.7 invariant 2; 0205 checks that a typed scope carries every required key                                                                                                     |
| `offerings`                   | Program, facility, name, kind (the SPK-CAT-002 kinds plus `party`, 0205), dates, registration window, eligibility reference date, eligibility and cancellation policy versions, entitlement, `capacity_units` jsonb, responsible manager, `publication_state`, provenance (`copied_from_offering_id`), `booking_terms_key` (rental and party, 0205)                                  |
| `offering_required_forms`     | Join table so every required form is a real policy version                                                                                                                                                                                                                                                                                                                           |
| `offering_sessions`           | Sequence (unique per offering), interval, optional `scheduling_event_id` (no cross-module FK), capacity override, status `scheduled/canceled/completed`                                                                                                                                                                                                                              |
| `price_rules`                 | Version per offering, `effective_from/to`, `base_price_minor` bigint + currency, `charge_lines` jsonb; `EXCLUDE USING gist` on `tstzrange(effective_from, effective_to)` per offering; trigger `price_rules_guard` forbids any change except closing/shortening the window; a rule is never deleted (0201)                                                                           |
| `discount_definitions`        | Code (case-insensitive unique) or automatic, percentage/fixed amount, eligibility rules, stacking rule and priority, cap, redemption and per-person limits, rounding, allocation method, effective dates, status                                                                                                                                                                     |
| `discount_redemptions`        | Counter per definition with the mirrored limit; `check (redeemed_count <= redemption_limit)` is the database guarantee of §4.7 invariant 7                                                                                                                                                                                                                                           |
| `discount_redemption_entries` | Append-only ledger: one `redeem` and at most one `release` per referencing record (replay-safe, §4.7 invariant 5); trigger `discount_redemption_entries_per_person_guard` (0207) refuses a redeem beyond the per-person limit                                                                                                                                                        |

Every table carries `organization_id`; references use composite `(organization_id, id)` keys;
editable records carry `revision` and `touch_updated_at`; append-only tables carry
`forbid_mutation`. The check `offerings_published_configuration_complete` refuses any offering
beyond `draft` that lacks its registration window, policies, entitlement, capacity or manager.

Stage-3 migrations (all **Verified** by the tests named):

- `0205_catalog_package_g_definitions.sql` (CAT-02): kinds `party`, `party_package`,
  `booking_terms` and `tax_fee`; `offerings.booking_terms_key` with `offerings_booking_terms_required`
  (a rental or party beyond draft or archived names its terms), `offerings_booking_terms_only_for_bookings`
  and the key format; `entitlement_definitions_{membership_benefit,package_credits,party_package,rental_resource}_scope`
  (every required key present; a membership's attendance mode is one of `none`,
  `included_sessions`, `unlimited`). `package-g-definitions.spec.ts` proves the database rejects
  each violation. The plan said `publication_state = 'draft'` for the booking-terms check; archived
  is also exempt so a draft rental or party can still be archived, like
  `offerings_published_configuration_complete`.
- `0206_catalog_program_source.sql` (CAT-03): `programs.source` `staff/import`
  (`program-import.spec.ts` "the database accepts only staff or import").
- `0207_catalog_discount_per_person_guard.sql` (CAT-04): before a `redeem` entry naming a person is
  inserted, the trigger locks the discount definition, counts the person's redeems minus releases
  and raises `check_violation` with constraint `discount_redemption_entries_per_person_limit` once
  `per_person_limit` is reached (`discount-per-person-guard.spec.ts`, PGlite and PostgreSQL).

## Endpoints (`/v1`, contracts in `packages/contracts/src/api/catalog.ts`)

| Method         | Path                                                                                                 | Action / who                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| POST/GET/PATCH | `/programs`, `/programs/{id}`                                                                        | `catalog.manage_programs` (program/league manager, GM, sysadmin) / `catalog.read_catalog` (staff)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| GET            | `/programs/{id}/offerings`                                                                           | staff listing of a program's offerings in every state, narrowed to the facilities the caller's `catalog.read_catalog` roles cover (§4.14, R4-AUTHZ-TARGETS-03); a reader scoped to one facility never lists another facility's offerings                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| POST/GET/PATCH | `/entitlement-definitions[/{id}]`                                                                    | `catalog.manage_entitlement_definitions` / read                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| POST/GET       | `/policy-versions`, `/policy-versions/{id}`, `/policy-versions/{id}/approvals`                       | `catalog.create_policy_version` (policy authors); approved versions readable by any principal of the organization, drafts by staff                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| POST           | `/policy-versions/{id}/approve`, `/policy-versions/{id}/retire`                                      | `catalog.approve_participation_policy` (program/league manager) or `catalog.approve_financial_policy` (finance operator), per kind                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| POST/GET       | `/acknowledgments`, `/acknowledgments/{id}/withdraw`                                                 | `catalog.record_acknowledgment`: the adult subject, a guardian holding `complete_forms`, or desk staff naming the signer; `signedAt` is server-stamped for customers, and staff may backdate a paper form only after the policy version, never in the future, with evidence (SPK-REG-009)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| POST           | `/offerings`, `PATCH /offerings/{id}`, `/offerings/{id}/copy`, `/offerings/{id}/archive`             | `catalog.manage_offerings`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| POST           | `/offerings/{id}/publish`                                                                            | `catalog.publish_offering` — VALIDATION_FAILED with `details.problems[]` naming every missing item (SPK-CAT-004), including `description_missing`, `format_missing` and `location_missing` (SPK-CAT-001); migration `0203` makes the database refuse a published offering without them                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| GET            | `/offerings/{id}/publication-check`                                                                  | CAT-01: `catalog.publish_offering` at the offering's facility; `{ offeringId, publicationState, revision, publishable, problems }` from publish's own validation and form resolution, plus `capability_disabled` for a gated kind; writes nothing (no approval, audit or event). §4.10: a caller without `catalog.read_catalog` gets NOT_FOUND for every id, and a reader whose reading roles do not cover the facility of an unpublished offering gets the same NOT_FOUND as for an unknown id (as `GET /offerings/{id}` answers); only an offering the caller can see is refused with ACCESS_DENIED                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| POST           | `/offerings/{id}/registration/open`, `/pause`, `/resume`, `/offerings/{id}/close`                    | `catalog.manage_registration_window` — distinct from publication; pausing changes nothing about existing participation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| GET            | `/offerings` (`@Public`, `organization=<slug>` for anonymous callers), `/offerings/{id}` (`@Public`) | published states only, child-safe `PublicOffering` (with `facility { id, name, timezone }`, SPK-SCHED-008); staff readers of `/offerings/{id}` get the `staff` block and every state. CAT-01: the list filters by `facilityId`, `kind`, `programId`, `format` and the date overlap `from`/`to`; `view=staff` gives holders of `catalog.manage_offerings` every state with `staff`, narrowed to the facilities of their managing roles, and anyone else the public view                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| POST/GET       | `/offerings/{id}/sessions`, `POST /sessions/{id}/cancel`                                             | `catalog.manage_sessions` (managers + scheduler); listing follows the offering's visibility; readers who are not catalog staff get the child-safe view (no cancel reason, scheduling event id or capacity staffing internals, §4.14). A session linked to a scheduling event must have the event's start and end, and the event must exist and not be canceled (VALIDATION_FAILED otherwise). Cancel also cancels the linked scheduling event with the caller's `scheduling.manage_events` authority and a fixed customer-safe reason, never the staff reason (R2-JOURNEYS-02); a refusal from scheduling refuses the whole cancel                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| GET            | `/sessions?facilityId&from&to&status&cursor&limit`                                                   | CAT-01: `catalog.read_catalog` at the facility; the sessions overlapping `[from, to)` (at most 31 days) in every offering state, keyset `(scheduled_start, id)`, each `{ sessionId, offeringId, offeringName, sequence, title, scheduledStart, scheduledEnd, status, facilityId, timezone }` so a desk builds an attendance ActivityRef                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| POST/GET       | `/offerings/{id}/price-rules`                                                                        | POST `catalog.manage_price_rules` (finance operator, GM, sysadmin) at the offering's facility; an effective rule is never edited, a change is a new version. GET `catalog.read_catalog` at the offering's facility; §4.10: an offering the caller cannot see (unpublished, at a facility their reading roles do not cover) is the same NOT_FOUND as an unknown id, and a discoverable one is ACCESS_DENIED                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| POST/GET/PATCH | `/discounts[/{id}]`, `POST /discounts/{id}/retire`                                                   | `catalog.manage_discounts` (finance)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| POST           | `/discounts/evaluate`                                                                                | `catalog.evaluate_discounts` (staff, or any person, staff without a reading role included, about a basket of their own: themselves and participants they hold `register` over); pure, no idempotency key. Each line is priced by the server from the offering (kind, program) and its effective price rule; submitted amounts and kinds are ignored (SPK-PAY-001). Staff power is the kernel's decision at each line's offering facility, never `principal.kind` (SPK-IAM-001/003, R4-AUTHZ-TARGETS-04): a staff member whose roles do not hold the action (an official) previews like a customer, and a role scoped to some facilities sees unpublished offerings only there (another facility's draft is NOT_FOUND, §4.10). A line's `participantPersonId` selects that person's per-person redemption counts, so unless staff authority covers the line's facility it must be the caller or someone they hold `register` over: PARTICIPANT_AUTHORITY_REQUIRED otherwise (ACCESS_DENIED for a facility-scoped reader at another facility), the same answer for any person id whatever their redemptions (SPK-IAM-003, §4.10). `at` (another instant) needs staff authority over the facility of every line's offering: without staff authority it is ACCESS_DENIED before any offering is looked up, and for staff whose authority does not cover every line's facility it is ACCESS_DENIED after visibility; both before any price rule is read. Everyone else previews the current instant and only discoverable offerings |

Every consequential POST/PATCH is `@Idempotent()` and validated with zod; every write runs inside
`UnitOfWork.run` with an audit record and the outbox events listed below. Publication records an
`approvals` row. Subject-permission authorization (acknowledgments) runs before the transaction
because the kernel consults the identity port without a transaction handle (see identity README,
"Kernel limitations"); the in-transaction signer check uses `AUTHORITY_LOOKUP_PORT` with the trx.

## Ports (`catalog.ports.ts`, provided by `CatalogModule`)

- `OFFERING_LOOKUP_PORT` → `OfferingsService.getOffering(organizationId, offeringId, at)`:
  the offering (staff view, with its facility zone), the price rule effective at `at`, the
  entitlement definition with its scope typed by kind (IF-23 `SnapshotEntitlementDefinition`: a
  Package G definition whose stored scope fails its schema is reported as null, so the consumer
  refuses), capacity units, the eligibility reference date (SPK-REG-002: configured, else the start
  date), the eligibility and cancellation policy versions, required form versions,
  `registrationOpen`, and `bookingTerms` (CAT-02: the approved `booking_terms` version of a rental
  or party effective at `at`, else null);
  `facilitiesOfOfferings(organizationId, offeringIds)` and
  `offeringIdsAtFacilities(organizationId, facilityIds)` give modules whose records hang off an
  offering its facility for authorization and list scope (§4.3, §4.14; enrollment).
- `POLICY_PORT` → `PoliciesService.getPolicyVersion`, `currentPolicyVersion(kind, key, at)`
  (approved, effective, highest version; IF-48 with the kinds `booking_terms` and `tax_fee`),
  `hasAcknowledgment(subject, policyVersion)`.
- `PRICING_PORT` → `PricingService.effectivePriceRule`, `evaluateDiscounts` (loads active
  definitions and counters, then the pure evaluator), `redeemDiscount` / `releaseDiscount` inside
  the caller's transaction (finance checkout, §4.11 step 7): replay-safe per reference, exhausted
  limits are `RESOURCE_CONFLICT` with `details.code` `DISCOUNT_REDEMPTION_LIMIT`,
  `DISCOUNT_PER_PERSON_LIMIT` or `DISCOUNT_NOT_ACTIVE`, and a discount outside its effective window
  at the server clock is `DISCOUNT_NOT_EFFECTIVE` (SPK-PAY-003; a quote priced earlier is
  re-quoted, never honoured after the window closed).
- Pure helpers for other modules: `evaluateDiscounts`, `roundBasisPoints`, `allocateAcrossLines`
  (`pricing/discount-evaluator.ts`), `equivalenceKey` / `periodKeyForDates`
  (`entitlements/equivalence-key.ts`), `requiredStaffFor`, `OFFERING_KIND_CAPABILITY`,
  `REQUIRED_ENTITLEMENT_KIND`, `BOOKING_OFFERING_KINDS` (`catalog.policy.ts`),
  `parseEntitlementScope`, `parsePolicyContent`, `typedEntitlementDefinition`.
- In-process import command (IF-40, CAT-03): `ProgramsService.create(principal, body,
correlationId, { importProvenance })` for the migration module (see "Import provenance").
- Fixtures for downstream tests: `testing/catalog-fixtures.ts` (`createProgramFixture`,
  `createPolicyVersionFixture`, `createEntitlementDefinitionFixture`, `createOfferingFixture`
  (fully configured and priced, in any publication state; a membership, package, rental or party
  offering gets a definition of its required kind, and a rental or party approved booking terms),
  `fixtureEntitlementScope`, `createPriceRuleFixture`,
  `createOfferingSessionFixture`, `createDiscountFixture`, `createAcknowledgmentFixture`) — use
  with `createTestApp({ imports: [CatalogModule], principalResolver: 'module' })`.

## Events (`catalog.events.ts`)

`catalog.program_created`, `catalog.program_updated`, `catalog.offering_created`,
`catalog.offering_updated` (carries `capacityChange` with the staffing requirement before/after),
`catalog.offering_published`, `catalog.registration_opened` (`resumed` flag),
`catalog.registration_paused`, `catalog.offering_closed`, `catalog.offering_archived`,
`catalog.offering_copied`, `catalog.session_created`, `catalog.session_canceled`,
`catalog.session_retimed` (previous and new times, the session's revision),
`catalog.policy_version_created`, `catalog.policy_version_approved`,
`catalog.policy_version_retired`, `catalog.acknowledgment_recorded` (`assistedByStaff`),
`catalog.acknowledgment_withdrawn`, `catalog.price_rule_created` (`supersededPriceRuleId`),
`catalog.discount_created`, `catalog.discount_updated`, `catalog.discount_retired`,
`catalog.discount_redeemed`, `catalog.discount_released`. Payloads carry identifiers and
configuration only, never participant data.

## Discount evaluation (SPK-PAY-003) — verified

Deterministic order: `stacking_priority`, then exclusive before stackable, then id. For each
candidate: active and effective at the instant; promo codes only when submitted (case-insensitive);
currency must match for fixed amounts; a reached redemption limit skips it; an applied exclusive
discount blocks the rest and an exclusive candidate is skipped once anything applied; eligibility
narrows lines by offering kind, offering, program, minimum line amount, early-registration cutoff,
minimum eligible lines (sibling) and per-participant usage; the amount is a percentage of the
eligible lines' remaining amount under the definition's rounding mode, or a fixed amount bounded by
that subtotal, then capped; allocation across lines is proportional (largest remainder, contracts
`allocate`), largest-first, first-line or even, never below zero per line. Every line carries a
human-readable `explanation[]` so a quote can be re-explained later (SPK-PAY-002).

`redemption_limit` counts one redemption per discounted participant: finance redeems each applied
discount once per participant whose lines it reduced, with reference type `order_line`
(R3-TIME-MONEY-01). The evaluation therefore discounts only the eligible lines of the first
participants, in line order, that the redemptions left cover (a line without a participant counts
as its own participant), explains it as "limited to N participant(s)", and checks `minLines` again
on that reduced set, so a quote never offers what checkout refuses with
`DISCOUNT_REDEMPTION_LIMIT` (**Verified**, R3-TIME-MONEY-01b: `pricing/discount-evaluator.spec.ts`
"organization-wide redemption limit counts discounted participants"; finance
`__tests__/discount-redemption.spec.ts`). What the limit counts is a **Proposed** engineering
default pending POL-011 / DEC-007.

## Package G definitions (CAT-02) — implemented behind capability switches

Whether the complex uses memberships, session packages, rentals, parties or pickup sessions is
**pending** (DEC-016 for all of them; DEC-072 memberships, DEC-074 session packages, DEC-076
rentals, DEC-077 parties, DEC-082 pickup sessions). The catalog mechanism is **verified**
(`package-g-definitions.spec.ts`); none of it is used until an administrator enables the switch.

- **Capability switches** (K-12, `OFFERING_KIND_CAPABILITY`). Creating, copying or publishing an
  offering of kind `membership`, `package`, `rental`, `party` or `pickup` calls
  `CapabilityService.require` inside the command's unit of work: a disabled capability is
  ACCESS_DENIED `details.code CAPABILITY_DISABLED` with the capability's applicability references.
  Archive, close, edits and reads are never gated. Only a system administrator changes a switch,
  naming DEC-016 or the capability's own decision, with audit (`POST /v1/admin/capabilities/...`,
  kernel). The publication check reports a disabled switch as `capability_disabled`. Test
  organizations start with `pickup_sessions` enabled (kernel `DEFAULT_TEST_CAPABILITIES`).
- **Typed scopes** (`ENTITLEMENT_SCOPE_SCHEMAS` in the contracts), validated on create and update,
  every key required and no defaults: `membership_benefit { attendance: none | included_sessions
{ appliesTo, limit { count, period week|month|membership_term, weekStartsOn (week only) } } |
unlimited { appliesTo }, term: offering_dates | from_confirmation { lengthDays }, renewal {
noticeLeadDays | null } }` (SPK-COND-001: unlimited only when stated); `package_credits { credits,
appliesTo, expiry: none | days_after_issue { days } | fixed_date { date } }` (SPK-COND-002);
  `party_package { durationMinutes, guestLimit, resources { resourceIds, count }, staffing [{ kind
supervisor|organizer, role, count, qualifications }], equipmentAssetIds }` and `rental_resource {
resources, staffing }` (SPK-COND-003). Values belong to POL-038, POL-039 and POL-040.
- **Package choices**: each party package is its own `party` offering with its own price rule,
  definition and terms, grouped under a program; a booking names the chosen offering, so there is
  no per-package price model.
- **Policy kinds** `booking_terms { confirmationMode instant|request, installmentPolicyKey | null,
setupMinutes?, cleanupMinutes?, accessConditions | null, hostResponsibilities | null }` (deposit =
  first installment of that approved policy; null = full charge at checkout; absent setup or
  cleanup minutes fall back to the resources' buffers) and `tax_fee { code, label, kind tax|fee,
rateBasisPoints | amountMinor + currency (exactly one), rounding half_up|half_even|down }`; both
  are approved through `catalog.approve_financial_policy` (finance operator) because they decide
  money (POL-005, POL-040, DEC-057, DEC-007). Eligibility content may carry `membershipRequired {
offeringIds?, programIds? }` (evaluated by enrollment, ENR-12) and cancellation content
  `packageCreditReturn { untilMinutesBeforeStart }` (ENR-11); only those keys are checked.
- **Publication**: a rental or party needs a `rental_resource` / `party_package` definition and
  approved booking terms effective when registration opens (`ENTITLEMENT_DEFINITION_REQUIRED`,
  `BOOKING_TERMS_REQUIRED`, and `booking_terms_installment_policy_missing` when the terms name a
  deposit plan with no approved version); a membership or package needs its `membership_benefit` /
  `package_credits` definition. Public views show the effective terms' id
  (`bookingTermsPolicyVersionId`) and never a scope or staffing.
- **Proposed**: the booking-terms instant (the later of now and the registration opening) and the
  check of the named installment policy are catalog choices; the entitlement effects themselves
  (attendance, redemption, renewal, booking holds) belong to enrollment and finance.

## Import provenance (CAT-03) — verified

`ProgramsService.create(principal, body, correlationId, { importProvenance })` is the in-process
program import command (IF-40, §5.3, §5.4, SPK-AT-024; `program-import.spec.ts`). Only
`systemPrincipal(org, 'migration.import:<batchId>')` of that batch passes `assertImportPrincipal`;
it joins the caller's unit of work, inserts `id = recordId` with `source: 'import'` and audits the
batch and external key. The same record with equal content returns the existing program with no
audit or event; different content is RESOURCE_CONFLICT `IMPORT_CONTENT_MISMATCH`. Staff over HTTP
cannot set `source` or the id. `Program.source` is in every program read, which is staff-only.

## Policy defaults (engineering defaults; the values await the cited operator decisions, §6.6)

- Approval roles per policy kind (`POLICY_APPROVAL_ACTION`): participation kinds (eligibility,
  waitlist, hold, approval, form) by program or league managers; financial kinds (cancellation,
  refund, discount, overpayment, installment, booking_terms, tax_fee) by the finance operator —
  DEC-003, DEC-006, DEC-007, DEC-009, DEC-057. Approving a newer version retires nothing
  automatically; retirement is explicit.
- SPK-YOUTH-002: the staffing requirement is `ceil(limit / participantsPerStaff)` summed over the
  units that carry a ratio; an update that raises it, or that removes or relaxes a unit's ratio
  (dropping the ratio, raising participants per staff member, or swapping the staffed unit for
  another), needs a `reason`. The requirement is published on `catalog.offering_updated` and the
  relaxed units are in the audit details (DEC-003 for the ratios themselves). `camp_group_places`
  units cannot be published without a group size and a ratio. A session `capacityOverride` is
  offering configuration: it needs `catalog.manage_offerings` as well as
  `catalog.manage_sessions`, follows the same camp-group rule, needs a `reason` when it raises the
  requirement, relaxes a ratio or adds unstaffed units to a staffed offering, and is recorded in
  the audit details and on `catalog.session_created`.
- A new price rule starts at or after the clock (refused otherwise in every case) and closes the
  current open-ended rule where it begins; bounded windows must not overlap an existing rule;
  historical prices are never rewritten (DEC-007 for the actual prices, taxes and rounding).
  Publication, and any edit of an offering beyond draft, require price rules that cover every
  instant of the remaining registration window, from the later of now and the opening to the
  closing (`price_rule_gap`, SPK-PAY-001).
- Retiring a policy version may shorten its window from now on, never extend or backdate it.
- A program's age band cannot change while the program has a published, open or paused offering
  (`PROGRAM_AGE_BAND_IN_USE`, SPK-REG-002); the versioned path is an eligibility policy version with
  explicit age limits. A permitted change records the age band before and after in the audit.
- Copying an offering (SPK-CAT-003) copies configuration, required forms and, on request, scheduled
  sessions shifted by the date difference, keeping facility-local wall-clock time (SPK-SCHED-008):
  a copy across a daylight-saving change keeps 09:00 at 09:00. A local time that does not exist or
  is ambiguous on the new date follows the default DST policy (shift forward, first occurrence) and
  is listed in the audit details as `dstResolutions`. Never price rules (finance prices each offering) and
  nothing transactional (enrollments, payments, attendance, results and permissions live elsewhere
  and reference the source id).
- The eligibility reference date defaults to the offering start date (POL-001 pending).
- Public discovery exposes `PublicOffering` only: no people, staffing internals or provenance
  (DEC-012 for the public information policy).

## Known gaps (pending or proposed)

- **Pending** DEC-003: discovery offers no age-band filter (the age band is shown on every
  offering; youth progression and staffing values are undecided).
- **Pending** DEC-016 and the Register E records: every Package G switch defaults to off; the
  catalog definitions exist but nothing books, redeems or renews them until enrollment and finance
  implement the effects and an administrator enables the capability.
- **Pending** DEC-004 (stage-3 "not doing": acting as customer for staff guardians): every session
  of a person with an active staff membership is a `staff` principal (identity `buildPrincipal`;
  there is no customer-only session), and `AcknowledgmentsService.record` chooses the
  staff-assisted path from `principal.kind`. Such a person therefore cannot be the signer of an
  acknowledgment, neither for themselves nor for their own child (the brief's "staff cannot be the
  signer"): without `signedByPersonId` the request is refused (400), naming themselves is refused
  (403) and the database refuses a staff-kind recorder who is the signer
  (`acknowledgments_staff_never_signer`). A coach or official holds no `ACKNOWLEDGMENT_STAFF` role,
  so they cannot record anyone's signature either. Until the decision, a desk colleague (front desk,
  program or league manager, support operator, administrator) records the guardian's signature with
  `signedByPersonId` naming them; without that record enrollment refuses the basket hold or booking
  that needs the form (`MISSING_ACKNOWLEDGMENT`). **Verified**
  `__tests__/policies-and-acknowledgments.spec.ts` "DEC-004 pending (SPK-REG-009, R3-TRACE-A-03)
  ...". **Proposed** for when DEC-004 settles how a
  staff member's own signature is told apart from desk assistance: the kernel already lets a staff
  principal use their own self and relationship authority (`AuthorizationService.decide`), so the
  service would take the staff-assisted path only when another signer is named by a holder of an
  `ACKNOWLEDGMENT_STAFF` role, and the constraint would keep applying to the rows recorded as
  staff-assisted.
- Resolved (CAT-05, verified, 2026-11-09): `GET /sessions` names each session's
  `schedulingEventId`, the event through which it holds space (null when it holds none), so the
  staff calendar can mark a scheduled session without booked space (SCR-S-03).
  `discovery-and-publication-check.spec.ts` and `session-scheduling-follow.spec.ts`.
- Resolved (CAT-04, verified): the per-person discount limit is now a database guarantee
  (migration 0207). `redeem()` locks the definition then the counter (the order discount updates
  use) and keeps its ledger count as early feedback; the trigger's
  `discount_redemption_entries_per_person_limit` refusal maps to `DISCOUNT_PER_PERSON_LIMIT`. A
  release restores the allowance of the participant on the redemption it reverses and copies that
  row's amount.
- Proposed: closed and archived offerings still show the program's current age band, because the
  offering reads it from the program. The complete fix is a catalog migration that copies the age
  band onto the offering and freezes it at publication.
- `offering_sessions.scheduling_event_id` is a plain uuid: the scheduling module owns the event and
  migration order forbids a cross-module key, so session creation checks the link through
  `EVENT_SCHEDULING_PORT.getEvent` instead (see "Session lifecycle and the scheduling event"). Session
  completion (`complete`) has no command yet (the entry module will drive it from attendance).
- Sessions have no update command: a time change is made on the scheduling event (the session
  follows it), any other correction is cancel + add (the cancel releases the event, so the
  replacement can take the same slot).
- Membership, package, rental and party offerings now have typed definitions (CAT-02), but their
  entitlement effects on attendance, redemption and booking (SPK-COND-001..003) are enrollment and
  finance behaviour, not implemented here.
- `GET /v1/sessions` reads offering sessions only; scheduling events without a catalog session are
  listed by the scheduling module (`GET /events`).

## Session lifecycle and the scheduling event (stage 6) — verified

Scheduling is the authority for the event that reserves a session's space (§4.2); catalog is the
authority for the session. Catalog now follows the event in both directions (SPK-AT-009
"consistent publication"); the gaps that remain in other modules are listed under "Pending" below.
Tests: `__tests__/session-scheduling-follow.spec.ts` (assembled application, PGlite and PostgreSQL).

- **Linking** (R2-JOURNEYS-03): a session created with a `schedulingEventId` must have the event's
  current start and end, and the event must exist and be draft or published; otherwise
  VALIDATION_FAILED (`details.path` `scheduledStart` with the event's times, or `schedulingEventId`)
  and nothing is written. A session covering part of a booking, or two sessions at different times
  on one event, is therefore refused rather than silently overwritten with the event's whole span
  later. A per-event advisory lock, taken by the creation, the catalog cancel and
  `catalog.follow_scheduling_event` before they read or lock the event's sessions (always in that
  order: the lock, the session rows, then scheduling's event row), makes a creation and a
  concurrent change of the event agree.
- **R2-JOURNEYS-02** (SPK-COMMS-002 cancellation): `POST /v1/sessions/{id}/cancel` cancels the linked
  event through `EVENT_SCHEDULING_PORT.cancelEvent` in the same unit of work, with the caller's own
  principal. The event's cancel reason is the fixed text `SESSION_CANCELED_EVENT_REASON` ("The
  program canceled this session."), because scheduling shows an event's cancel reason to its
  participants and communications appends it to the families' notice, while the catalog reason is
  staff-only (§4.14); the staff reason stays on the session and in its audit record. Scheduling's
  `event_changed` 'canceled' then releases the reservation, updates the calendar projection and ICS
  feeds, sends the families one "Canceled" notice and leaves no activity reminder;
  `catalog.follow_scheduling_event` finds nothing left to cancel. A refusal from scheduling (no
  `scheduling.manage_events` at the event's facility, the facility's schedule still held by the
  legacy system, or the event canceled in scheduling concurrently, which gives INVALID_TRANSITION;
  a retry then finds it `already_canceled`) refuses the whole cancel. The audit details record
  `schedulingEvent { id, outcome }`: `canceled`, `already_canceled`, `not_found` (a dangling id,
  only possible for a session linked before the link was checked), `kept_shared` (another scheduled session still uses the event; the last one to
  be canceled releases it, and a per-event advisory lock makes concurrent cancels agree) or
  `kept_owned_elsewhere` (the event belongs to a fixture or a rental or party booking, whose module
  decides).
- **R2-JOURNEYS-03** (SPK-COMMS-005, SPK-YOUTH-007, SPK-ENTRY-003): on every `event_changed` other
  than 'canceled' ('moved' or 'resized' by a series edit, a schedule-draft publication or a closure
  resolved by rescheduling; 'published' when a draft event, moved while still a draft without any
  delivery, is published through a schedule draft) the linked scheduled sessions take the event's
  current published times, read through scheduling's port in the handler's transaction (never the
  payload, so a late redelivery of an older move changes nothing), with a revision bump, an audit
  record `catalog.session_retimed` and the event `catalog.session_retimed`. Copying the event's
  span is correct because a linked session is created at its event's times (Linking above).
  Readers of catalog sessions see the new time at once (tested: the family calendar's enrollment
  items and `GET /v1/sessions`; entry's check-in window reads the same session rows through
  `SessionsService.list`). Canceled sessions and draft events are left alone;
  a change that leaves the times as they are changes nothing.
- **Followed by the modules that copy session times or audiences** (stage-6 integration,
  **Verified**): enrollment's `enrollment.follow_session_retimed` moves the session's live
  `session_bookings` to the session's current times (`enrollment/__tests__/session-retimed.spec.ts`,
  family calendar `session_booking` item and replay included), and the family calendar skips
  bookings of sessions that are not scheduled; workforce's `workforce.follow_session_retimed`
  retimes live `session`-target assignments through its usual retime, access window included
  (`workforce/__tests__/access-follow-ups.spec.ts` "R2-JOURNEYS-03"); enrollment's
  `SessionParticipants` leaves the participants of a canceled session out of the audience of an
  event another linked session still holds (`kept_shared`), so they get none of its later change
  notices or reminders (this file, "R2-JOURNEYS-02 / SPK-COMMS-002 (kept_shared)").
- **Who is told of a cancellation.** Enrollment consumes `catalog.session_canceled`
  (`enrollment.follow_session_canceled`) and tells each family whose session booking it cancels
  (`enrollment.notify_session_booking_canceled`, with the catalog's customer-safe reason on the
  booking, never the staff one). **Pending:** in the `kept_shared` and `kept_owned_elsewhere`
  outcomes the event stays published, so scheduling sends no "Canceled" notice, and the families
  enrolled in the offering (not booked into the session) are not told the session is canceled
  (SPK-COMMS-002). In `kept_owned_elsewhere` (a fixture's or booking's event) they also stay in
  that event's audience. Closing it needs a `catalog.session_canceled` consumer in communications
  (a family notice with the customer-safe text, never the staff reason), or the outcome carried on
  the event so communications can tell those families.

## Stage-3 integration fixes — verified 2026-10-29

Review findings fixed when the stage-3 branches were integrated (each with its test):

- Migration `0208_catalog_discount_guard_hardening.sql`: a release must reverse a redeem of the
  same discount, reference and person (`discount_redemption_entries_release_matches_redeem`); a
  redeem locks the definition `FOR NO KEY UPDATE` (no deadlock with the counter), and a redeem of a
  per-person-limited discount without a person is refused by the database
  (`discount_redemption_entries_person_required`); the service answers `VALIDATION_FAILED`
  `DISCOUNT_PERSON_REQUIRED` first. Tests: `__tests__/discount-per-person-guard.spec.ts`,
  `__tests__/pricing.spec.ts`.
- Migration `0209_catalog_package_g_scope_effects.sql`: the four Package G scope checks use
  immutable helper functions and refuse a malformed scope instead of letting a `null` pass
  (`__tests__/package-g-definitions.spec.ts`, database rejection test).
- Reference checks: entitlement definitions and eligibility policies may only name offerings and
  programs of the organization (`assertCatalogReferences`, `VALIDATION_FAILED` `unknown_reference`
  on the path); a party or rental offering's publication check names unknown, foreign-facility,
  closed or retired resources and equipment (`booking_resource_*`, `booking_equipment_*`). The
  module now imports `SchedulingModule` and `FacilitiesModule` for these reads.
- The publication check is a staff read: a customer gets `NOT_FOUND` for a draft and for an
  unknown id (`__tests__/discovery-and-publication-check.spec.ts`); program creation always
  validates its body, imported or not (`__tests__/program-import.spec.ts`).
- Stage-8 review (§4.3, §4.14, §4.10, SPK-IAM-001/003), **Verified**
  `__tests__/facility-scoped-reads.spec.ts`: `GET /programs/{id}/offerings` is narrowed with the
  kernel's `listFacilityScope` for `catalog.read_catalog` (R4-AUTHZ-TARGETS-03), and
  `POST /discounts/evaluate` decides staff power with the kernel at each line's offering facility,
  keeping the caller's own self authority when no staff role holds the action
  (R4-AUTHZ-TARGETS-04). Follow-up (SPK-IAM-003, §4.10): the preview's participants are
  authorized like basket lines (`catalog.evaluate_discounts` names `register`), so a stranger,
  an official or a guardian holding only `view` gets the same PARTICIPANT_AUTHORITY_REQUIRED before
  and after another person's redemption; `GET /offerings/{id}/price-rules` and
  `GET /offerings/{id}/publication-check` answer another facility's draft exactly as an unknown id.
- Cross-module journeys over this module: `apps/api/src/__tests__/journeys/spk-cond-00*.spec.ts`,
  `pos-to-accounting-export.spec.ts` (approved `tax_fee` versions).

## Park UI gaps (docs/design/park-ui-redesign.md) — verified

Tests in `__tests__/park-ui-gaps.spec.ts`.

- **Session location** (SPK-CAT-001, migration `0210_catalog_session_location.sql`): `POST
/v1/offerings/{id}/sessions` takes an optional `location` (`{ label?, resourceIds? }`, resources
  of the offering's facility, checked against scheduling's inventory; VALIDATION_FAILED
  `location.resourceIds` otherwise). The database refuses a location that is not an object, has a
  blank or non-string label, a non-array or over-long `resourceIds`, or states neither. The
  child-safe session view shows the label only. A copy keeps it. There is no command to change it
  later (proposed).
- **`GET /v1/sessions`** rows carry `location` (`scheduling_event`: the resources the linked event
  reserves, scheduling being the authority; else `session`, else `offering`, else `none`; resource
  names from scheduling) and `capacity` (`session` override or `offering` units). The live fill is
  enrollment's capacity pools.
- **Discover search**: `GET /v1/offerings?q=` (2..100 characters): every word, case-insensitively,
  in the name, description, activity type, format, location label or program name; LIKE wildcards
  are literal. No index: a sequential filter within the organization (fine at catalog sizes).
- **Promotions** (SPK-PAY-003): `PublicOffering.promotions` lists active automatic discounts in
  their window whose offering kind/id/program, early-registration deadline, minimum line amount and
  currency the offering meets, with `basis` `early_registration` / `multi_line` / `automatic`.
  Promo codes, exhausted limits and drafts are never listed. Badges are informational; the
  evaluation (`POST /v1/discounts/evaluate`) and finance's quote decide what applies.
