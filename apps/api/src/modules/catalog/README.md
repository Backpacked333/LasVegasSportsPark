# catalog module

**Owns:** programs, offerings, offering sessions, entitlement definitions, policy versions,
approvals, acknowledgments, price rules, discount definitions, discount redemption counters and
ledger

**Specification:** §3.2 (SPK-CAT-001..004), §3.15 SPK-PAY-001..003 (price rules and discount
definitions; the quote itself belongs to finance), §4.4 Catalog + Policies (PolicyVersion,
Acknowledgment, Approval), §4.5 "`Offering.priceCents` must become versioned price rules and
quotes", SPK-REG-002 (versioned eligibility policies and the configured reference date), SPK-REG-009
("staff must not falsely sign a guardian acknowledgment"), SPK-YOUTH-001/002 (program kinds,
capacity and staffing configuration), §4.7 invariants 2, 5 and 7

**Migration range:** `packages/db/migrations/0200_catalog_core.sql` … `0299`

**Depends on:** identity (`PERSON_DIRECTORY_PORT` for person checks, `AUTHORITY_LOOKUP_PORT` for the
`complete_forms` authority of a signer). Consumes no domain events.

**Status: implemented** (verified by `apps/api/src/modules/catalog/__tests__` and the unit specs
next to the code: `pricing/discount-evaluator.spec.ts`, `entitlements/equivalence-key.spec.ts`,
`catalog.state-machines.spec.ts`). Statements below are verified unless marked proposed or pending.

## Tables (migrations `0200_catalog_core.sql`, `0201_catalog_history_guards.sql`)

| Table                         | Purpose                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `programs`                    | Reusable definitions: name (unique per organization), activity type, format, age band, status `draft/active/archived`                                                                                                                                                                                                                                                                |
| `policy_versions`             | `(kind, key, version)` unique per organization; kinds eligibility, cancellation, refund, discount, waitlist, hold, approval, form, overpayment, installment; `approval_status` `draft/approved/retired`; trigger `policy_versions_guard` makes approved content immutable and an approved window only shorter (0201); approved and retired versions are never deleted (0201)         |
| `approvals`                   | Append-only approval facts (policy versions, offering publications) with actor, reason, details                                                                                                                                                                                                                                                                                      |
| `acknowledgments`             | Subject, policy version, signer, basis `self/guardian`, recorder snapshot and kind, evidence, status; partial unique index on active `(subject, policy version)`; check `acknowledgments_staff_never_signer`; trigger `acknowledgments_guard` (0202) refuses rewriting signer, basis, recorder, `signed_at` or evidence and reopening a withdrawal, `forbid_mutation` refuses delete |
| `entitlement_definitions`     | Kind (team_entry, roster_place, seat, session_seat, camp_group_place, rental_resource, package_credits, membership_benefit), scope, `equivalence_scope` + rule used by enrollment for §4.7 invariant 2                                                                                                                                                                               |
| `offerings`                   | Program, facility, name, kind (the eleven SPK-CAT-002 kinds), dates, registration window, eligibility reference date, eligibility and cancellation policy versions, entitlement, `capacity_units` jsonb, responsible manager, `publication_state`, provenance (`copied_from_offering_id`)                                                                                            |
| `offering_required_forms`     | Join table so every required form is a real policy version                                                                                                                                                                                                                                                                                                                           |
| `offering_sessions`           | Sequence (unique per offering), interval, optional `scheduling_event_id` (no cross-module FK), capacity override, status `scheduled/canceled/completed`                                                                                                                                                                                                                              |
| `price_rules`                 | Version per offering, `effective_from/to`, `base_price_minor` bigint + currency, `charge_lines` jsonb; `EXCLUDE USING gist` on `tstzrange(effective_from, effective_to)` per offering; trigger `price_rules_guard` forbids any change except closing/shortening the window; a rule is never deleted (0201)                                                                           |
| `discount_definitions`        | Code (case-insensitive unique) or automatic, percentage/fixed amount, eligibility rules, stacking rule and priority, cap, redemption and per-person limits, rounding, allocation method, effective dates, status                                                                                                                                                                     |
| `discount_redemptions`        | Counter per definition with the mirrored limit; `check (redeemed_count <= redemption_limit)` is the database guarantee of §4.7 invariant 7                                                                                                                                                                                                                                           |
| `discount_redemption_entries` | Append-only ledger: one `redeem` and at most one `release` per referencing record (replay-safe, §4.7 invariant 5)                                                                                                                                                                                                                                                                    |

Every table carries `organization_id`; references use composite `(organization_id, id)` keys;
editable records carry `revision` and `touch_updated_at`; append-only tables carry
`forbid_mutation`. The check `offerings_published_configuration_complete` refuses any offering
beyond `draft` that lacks its registration window, policies, entitlement, capacity or manager.

## Endpoints (`/v1`, contracts in `packages/contracts/src/api/catalog.ts`)

| Method         | Path                                                                                                 | Action / who                                                                                                                                                                                                                                                                              |
| -------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST/GET/PATCH | `/programs`, `/programs/{id}`                                                                        | `catalog.manage_programs` (program/league manager, GM, sysadmin) / `catalog.read_catalog` (staff)                                                                                                                                                                                         |
| GET            | `/programs/{id}/offerings`                                                                           | staff listing of a program's offerings in every state                                                                                                                                                                                                                                     |
| POST/GET/PATCH | `/entitlement-definitions[/{id}]`                                                                    | `catalog.manage_entitlement_definitions` / read                                                                                                                                                                                                                                           |
| POST/GET       | `/policy-versions`, `/policy-versions/{id}`, `/policy-versions/{id}/approvals`                       | `catalog.create_policy_version` (policy authors); approved versions readable by any principal of the organization, drafts by staff                                                                                                                                                        |
| POST           | `/policy-versions/{id}/approve`, `/policy-versions/{id}/retire`                                      | `catalog.approve_participation_policy` (program/league manager) or `catalog.approve_financial_policy` (finance operator), per kind                                                                                                                                                        |
| POST/GET       | `/acknowledgments`, `/acknowledgments/{id}/withdraw`                                                 | `catalog.record_acknowledgment`: the adult subject, a guardian holding `complete_forms`, or desk staff naming the signer; `signedAt` is server-stamped for customers, and staff may backdate a paper form only after the policy version, never in the future, with evidence (SPK-REG-009) |
| POST           | `/offerings`, `PATCH /offerings/{id}`, `/offerings/{id}/copy`, `/offerings/{id}/archive`             | `catalog.manage_offerings`                                                                                                                                                                                                                                                                |
| POST           | `/offerings/{id}/publish`                                                                            | `catalog.publish_offering` — VALIDATION_FAILED with `details.problems[]` naming every missing item (SPK-CAT-004)                                                                                                                                                                          |
| POST           | `/offerings/{id}/registration/open`, `/pause`, `/resume`, `/offerings/{id}/close`                    | `catalog.manage_registration_window` — distinct from publication; pausing changes nothing about existing participation                                                                                                                                                                    |
| GET            | `/offerings` (`@Public`, `organization=<slug>` for anonymous callers), `/offerings/{id}` (`@Public`) | published states only, child-safe `PublicOffering`; staff readers get the `staff` block and every state                                                                                                                                                                                   |
| POST/GET       | `/offerings/{id}/sessions`, `POST /sessions/{id}/cancel`                                             | `catalog.manage_sessions` (managers + scheduler); listing follows the offering's visibility; readers who are not catalog staff get the child-safe view (no cancel reason, scheduling event id or capacity staffing internals, §4.14)                                                      |
| POST/GET       | `/offerings/{id}/price-rules`                                                                        | `catalog.manage_price_rules` (finance operator, GM, sysadmin); an effective rule is never edited, a change is a new version                                                                                                                                                               |
| POST/GET/PATCH | `/discounts[/{id}]`, `POST /discounts/{id}/retire`                                                   | `catalog.manage_discounts` (finance)                                                                                                                                                                                                                                                      |
| POST           | `/discounts/evaluate`                                                                                | `catalog.evaluate_discounts` (staff, or a customer about their own basket); pure, no idempotency key                                                                                                                                                                                      |

Every consequential POST/PATCH is `@Idempotent()` and validated with zod; every write runs inside
`UnitOfWork.run` with an audit record and the outbox events listed below. Publication records an
`approvals` row. Subject-permission authorization (acknowledgments) runs before the transaction
because the kernel consults the identity port without a transaction handle (see identity README,
"Kernel limitations"); the in-transaction signer check uses `AUTHORITY_LOOKUP_PORT` with the trx.

## Ports (`catalog.ports.ts`, provided by `CatalogModule`)

- `OFFERING_LOOKUP_PORT` → `OfferingsService.getOffering(organizationId, offeringId, at)`:
  the offering (staff view), the price rule effective at `at`, the entitlement definition, capacity
  units, the eligibility reference date (SPK-REG-002: configured, else the start date), the
  eligibility and cancellation policy versions, required form versions, and `registrationOpen`.
- `POLICY_PORT` → `PoliciesService.getPolicyVersion`, `currentPolicyVersion(kind, key, at)`
  (approved, effective, highest version), `hasAcknowledgment(subject, policyVersion)`.
- `PRICING_PORT` → `PricingService.effectivePriceRule`, `evaluateDiscounts` (loads active
  definitions and counters, then the pure evaluator), `redeemDiscount` / `releaseDiscount` inside
  the caller's transaction (finance checkout, §4.11 step 7): replay-safe per reference, exhausted
  limits are `RESOURCE_CONFLICT` with `details.code` `DISCOUNT_REDEMPTION_LIMIT`,
  `DISCOUNT_PER_PERSON_LIMIT` or `DISCOUNT_NOT_ACTIVE`.
- Pure helpers for other modules: `evaluateDiscounts`, `roundBasisPoints`, `allocateAcrossLines`
  (`pricing/discount-evaluator.ts`), `equivalenceKey` / `periodKeyForDates`
  (`entitlements/equivalence-key.ts`), `requiredStaffFor` (`catalog.policy.ts`).
- Fixtures for downstream tests: `testing/catalog-fixtures.ts` (`createProgramFixture`,
  `createPolicyVersionFixture`, `createEntitlementDefinitionFixture`, `createOfferingFixture`
  (fully configured and priced, in any publication state), `createPriceRuleFixture`,
  `createOfferingSessionFixture`, `createDiscountFixture`, `createAcknowledgmentFixture`) — use
  with `createTestApp({ imports: [CatalogModule], principalResolver: 'module' })`.

## Events (`catalog.events.ts`)

`catalog.program_created`, `catalog.program_updated`, `catalog.offering_created`,
`catalog.offering_updated` (carries `capacityChange` with the staffing requirement before/after),
`catalog.offering_published`, `catalog.registration_opened` (`resumed` flag),
`catalog.registration_paused`, `catalog.offering_closed`, `catalog.offering_archived`,
`catalog.offering_copied`, `catalog.session_created`, `catalog.session_canceled`,
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

## Policy defaults (engineering defaults; the values await the cited operator decisions, §6.6)

- Approval roles per policy kind (`POLICY_APPROVAL_ACTION`): participation kinds (eligibility,
  waitlist, hold, approval, form) by program or league managers; financial kinds (cancellation,
  refund, discount, overpayment, installment) by the finance operator — DEC-003, DEC-006, DEC-007,
  DEC-009. Approving a newer version retires nothing automatically; retirement is explicit.
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

## Known gaps

- A person who holds any staff role is a `staff` principal and therefore cannot be the signer of an
  acknowledgment, even for their own child (the brief's "staff cannot be the signer"). A coach who
  is also a guardian needs a customer-only session or a desk colleague to record the guardian's
  signature; lifting this needs a kernel notion of "acting as customer" (pending DEC-004).
- Per-person discount limits are enforced in the service from the ledger, not by a database
  constraint; the organization-wide limit is. Concurrent redemptions of one discount serialize on
  the counter row lock that `redeem()` takes before counting, so the per-person check holds under
  concurrency (`pricing.spec.ts`, run under PGlite and PostgreSQL). A release restores the
  allowance of the participant on the redemption it reverses and copies that row's amount.
- Proposed: closed and archived offerings still show the program's current age band, because the
  offering reads it from the program. The complete fix is a catalog migration that copies the age
  band onto the offering and freezes it at publication.
- `offering_sessions.scheduling_event_id` is a plain uuid: the scheduling module owns the event and
  migration order forbids a cross-module key. Session completion (`complete`) has no command yet
  (the entry module will drive it from attendance).
- Sessions have no update command; corrections are cancel + add.
- Membership and package offerings are catalogued (SPK-CAT-002) but their entitlement effects on
  attendance (SPK-COND-001/002) are enrollment/finance behaviour, not implemented here.
