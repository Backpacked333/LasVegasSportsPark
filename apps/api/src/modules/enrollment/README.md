# enrollment module

**Owns:** applications, enrollments, household baskets and basket lines, placement requests,
session bookings, capacity pools, holds, allocations, waitlist entries and offers, makeup
entitlements and their redemption history, trial participations; and, behind their capability
switches (§3.16, §6.5 Package G), package entitlements and redemptions, membership suspensions and
benefit uses, rental and party bookings, assessment templates, assessments and progression
recommendations (the last three: owner **Proposed**, §4.4 names no entity)

**Specification:** §3.3 (SPK-REG-001..010), §3.6 (SPK-PLACE-001..005), §3.13 (SPK-YOUTH-001..004,
SPK-YOUTH-007), §4.4 Participation (Application, Enrollment, PlacementRequest, SessionBooking) and
Capacity (CapacityPool, Hold, Allocation, WaitlistEntry, WaitlistOffer), §4.5, §4.6 Application /
Enrollment / Placement / Hold / SessionBooking machines, §4.7 invariants 2, 3, 7, §4.8
(`POST /v1/enrollments/{id}/transfer`, `POST /v1/waitlist-offers/{id}/accept`), SPK-AT-001, 004,
005, 006, 015 (precondition), 019, 020; stage 3: §3.16 (SPK-COND-001 to SPK-COND-003),
SPK-YOUTH-005, SPK-YOUTH-006, SPK-UX-001, SPK-UX-004, SPK-SCHED-008, SPK-COMMS-002, SPK-IAM-007

**Migration range:** `packages/db/migrations/0500_enrollment_*.sql` … `0599` (this module uses
`0500` to `0512`; `0503` came from the review stage, `0510` to `0512` from the stage-5 review)

**Depends on:** identity (`PERSON_DIRECTORY_PORT` for participants, `RelationshipAuthority` for the
family calendar's current grants), catalog (`OFFERING_LOOKUP_PORT`, `POLICY_PORT`, `PRICING_PORT`,
`SessionsService`), competition (`TEAM_ENTRY_QUERY_PORT`, `ELIGIBILITY_PORT`, `ROSTER_PORT`, and
`RosterService.changeRoster` for placement roster additions), scheduling (`EVENT_SCHEDULING_PORT`,
`AVAILABILITY_PORT`, `ResourcesService` names, local-time helpers), workforce
(`WORKFORCE_STAFFING_PORT`, `ASSIGNMENT_COVERAGE_PORT`), facilities (`ASSET_DIRECTORY_PORT`),
communications (`NotificationsService.composeAndQueueIn`, IF-22) and the kernel (capability
switches, periodic jobs, module settings, facility directory, operational exceptions). It never
writes another module's tables (§4.2).

**Status: implemented** — verified by `apps/api/src/modules/enrollment/__tests__` (PGlite and
`TEST_DATABASE_URL` PostgreSQL) and the unit specs next to the code
(`eligibility/registration-eligibility.spec.ts`, `enrollment.policy.spec.ts`,
`enrollment.shared.spec.ts`, `services/family-calendar.service.spec.ts`). Statements below are
verified unless marked proposed or pending.

## Tables (migration `0500_enrollment_core.sql`)

| Table                  | Purpose                                                                                                                                                                                                                                                                      |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `capacity_pools`       | Scope `offering/session/division/team_entry/camp_group/rental`, unit (catalog capacity units), `constraint_kind` `commercial/staffing/space`, `capacity`, `committed`, `held`; staffing pools keep `participants_per_staff` and `staff_count`; one per scope+unit+constraint |
| `holds`                | Pool, quantity, owner (`basket/waitlist_offer/session_booking/placement/staff`), server-owned `expires_at`, exactly one terminal fact (`committed_at`/`released_at`/`expired_at`)                                                                                            |
| `allocations`          | Committed capacity per enrollment, session booking or placement; from at most one hold; `active/released` (released rows stay as history)                                                                                                                                    |
| `applications`         | Intent (the eight SPK-REG-001 intents), participant, submitter snapshot, payer, ApplicationMachine status, `eligibility_result` (policy version, reference date, reasons, alternatives), `override` (actor, reason, original reasons), `requires_approval`                   |
| `baskets`              | Owner (adult), payer, creator snapshot, `assisted_by_person_id` (staff actor), `fulfillment_mode` `all_or_nothing/partial` (+ explicit acceptance), status, hold expiry, currency, finance `order_ref`, last operation                                                       |
| `basket_lines`         | Participant, offering, session, team entry, intent, quantity, application, trial link, entitlement, equivalence key, eligibility, price snapshot (catalog `PricingPort`), policy references, approval flag, enrollment and outcome                                           |
| `enrollments`          | EnrollmentMachine status with its facts, equivalence key, payer, registrant snapshot and staff actor, source application, basket line, placement, trial, `order_ref`, price snapshot, policies, cancellation policy/consequence, transfer links both ways                    |
| `placement_requests`   | SPK-PLACE-001 information (availability, preferred competition/division, declared level, positions, requested teammates), PlacementMachine status, proposal/assignment facts and reasons, roster membership reference, operation                                             |
| `session_bookings`     | Kind `pickup/trial/makeup/session`, SessionBookingMachine status, pool and primary hold, makeup entitlement, session instants (copied), booker snapshot, staff actor, payer, price, policies, eligibility, expiry                                                            |
| `waitlist_entries`     | Offering (and session for session waitlists), primary pool, participant, intent, priority basis and rank, `joined_at` (fact) and `queued_at` (order), preferences, status `waiting/offered/accepted/expired/withdrawn/removed`, offer count                                  |
| `waitlist_offers`      | Entry, pool, primary hold, expiry, status `offered/accepted/expired/declined`, accepted basket/enrollment/session booking                                                                                                                                                    |
| `makeup_entitlements`  | Participant, origin (enrollment, session, kind, reference), eligible replacement offerings/programs, expiry, `redemption_limit`, `redeemed_count`, status `active/exhausted/expired/revoked`; no money columns (SPK-YOUTH-004)                                               |
| `makeup_redemptions`   | Append-only history (`forbid_mutation`): `redeem` and `reversal` rows; one per booking and kind; a reversal names what it reverses                                                                                                                                           |
| `trial_participations` | Trial offering/session/booking, status `scheduled/attended/no_show/canceled/converted`, follow-up consent, follow-up basket, converted enrollment                                                                                                                            |

Every table carries `organization_id`; references use composite `(organization_id, …)` keys,
including references into identity, catalog and competition tables; editable records carry
`revision` and `touch_updated_at`.

### Database guarantees (tests in `__tests__/enrollment-schema.spec.ts`)

- **§4.7 invariant 2 / SPK-AT-004:** `enrollments_equivalent_active_idx` — partial unique
  `(organization, participant, equivalence_key)` over `pending/confirmed`; the key comes from the
  catalog entitlement definition (`equivalenceKey`). Also one open application per participant and
  offering (`applications_open_idx`), one live booking per session, one live waitlist entry per
  pool, one live placement request per season, one scheduled trial per trial offering.
- **§4.7 invariant 3 / SPK-AT-005:** `check (committed + held <= capacity)` and non-negative
  counters; every acquisition is `UPDATE … WHERE committed + held + n <= capacity` under the row
  lock, pools acquired in id order. Fifty concurrent holds on the final place leave exactly one.
- **SPK-REG-006:** `holds_one_terminal_outcome` (status and fact agree) plus trigger `holds_guard`
  (a terminal hold never changes; pool and quantity are fixed).
- **SPK-REG-008:** trigger `waitlist_offers_guard` (an offer is consumed once) and one open offer
  per entry.
- **§4.6:** triggers `enrollments_transition_guard`, `applications_transition_guard`,
  `placement_requests_transition_guard` and `session_bookings_transition_guard` refuse every
  transition their machines do not allow (`holds_guard` does the same for holds); state checks list
  exactly the machine states (no "waitlisted" enrollment, §4.5).
- **§4.7 invariant 7 / SPK-AT-020:** trigger `makeup_redemptions_apply` locks the entitlement,
  refuses an inactive/expired/foreign redemption and a reversal that does not correct a redemption
  of the same entitlement and booking, and moves the counter; `check (redeemed_count <=
redemption_limit)` is the final guarantee.

## Endpoints (`/v1`, contracts in `packages/contracts/src/api/enrollment.ts`)

| Method   | Path                                                                                                      | Who (action)                                                                                                       |
| -------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| POST/GET | `/applications`, `/applications/{id}`                                                                     | adult self or a holder of `register` (`enrollment.apply`); staff assisting; reads: `view` holders, staff readers   |
| POST     | `/applications/{id}/override-eligibility`                                                                 | program/league manager, GM, sysadmin (`enrollment.override_eligibility`) with reason; audited                      |
| POST     | `/applications/{id}/accept`, `/decline`, `/withdraw`                                                      | review: program administration (`enrollment.review_application`); withdraw: participant authority or staff         |
| POST/GET | `/baskets`, `/baskets/{id}`, `/baskets/{id}/lines`, `/lines/{lineId}/remove`                              | the household adult (self) or desk staff (`enrollment.manage_basket`)                                              |
| POST     | `/baskets/{id}/hold`, `/release`, `/complete`                                                             | same, re-checked per line; `release` refuses 409 `CHECKOUT_IN_PROGRESS` in a checkout; `complete` if nothing owed  |
| GET      | `/enrollments`, `/enrollments/{id}`, `/enrollments/{id}/cancellation-preview`                             | `view` holders (payer and registrant redacted for other adults, SPK-AT-004), staff readers                         |
| POST     | `/enrollments/{id}/cancel`, `/transfer` (`commit=false` preview), `/complete`                             | participant authority or desk staff; complete: program administration                                              |
| POST/GET | `/waitlist-entries`, `/waitlist-entries/{id}`, `/withdraw`, `/remove`                                     | participant authority (`enrollment.join_waitlist`); listing and `remove` (reason required): program administration |
| GET/POST | `/waitlist-offers/{id}`, `/accept`, `/decline`                                                            | participant authority                                                                                              |
| POST/GET | `/placement-requests`, `/{id}`, `/{id}/candidates`, `/propose`, `/reject-proposal`, `/assign`, `/release` | request: participant authority; everything else league administration (`enrollment.manage_placement`)              |
| POST/GET | `/session-bookings`, `/{id}`, `/confirm`, `/cancel`                                                       | pickup seats: participant authority (`enrollment.book_session`); session lists: staff                              |
| POST/GET | `/makeup-entitlements`, `/{id}`, `/{id}/redeem`, `/{id}/revoke`                                           | issue/revoke: program administration and front desk; redeem: participant authority                                 |
| POST/GET | `/trial-participations`, `/{id}`, `/outcome`, `/convert`                                                  | participant authority; attendance outcomes: staff                                                                  |
| POST/GET | `/capacity-pools`, `/capacity-pools/{id}/adjust`, `/offerings/{id}/capacity-pools/sync`                   | program administration (`enrollment.manage_capacity`); staffing changes need a reason                              |
| GET      | `/me/family-calendar?from&to`                                                                             | the acting adult: self plus every person they hold `view` over (`enrollment.read_family_calendar`)                 |

Every consequential POST is `@Idempotent()` and zod-validated; every write runs in
`UnitOfWork.run` with an audit record and outbox follow-ups. Customer-private records answer
`NOT_FOUND` to anyone without authority (§4.10); organization scope comes from the token. A
staff-only command (override, review, placement, waitlist removal, makeup revocation) answers
`NOT_FOUND` to a customer who may not read the record and `ACCESS_DENIED` to one who may (their
own child's record) and to staff without the role. Adding a basket line needs `register` over both
the basket's household adult and the participant, so authority over a shared child never opens
another household's basket.

## Ports (`enrollment.ports.ts`, provided by `EnrollmentModule`)

- `ENROLLMENT_PORT` (`EnrollmentPort`, finance and entry): `participationsOf` (per-child active
  enrollments and session bookings), `getEnrollment`, `holdsForBasket`, `commitHolds(trx, org,
holdIds)` (locks in id order; CAPACITY_UNAVAILABLE and nothing written when any hold is not
  active or has passed its server-owned expiry; each allocation names the line's enrollment, the
  booking or the placement), `confirmEnrollment(trx, …)` after payment facts (commits its holds,
  or re-acquires a free place after expiry while nobody waits; never displaces an offer —
  SPK-AT-006), `failConfirmation` (pending enrollments only), `confirmSessionBooking` (same rules
  for session seats).
- `CAPACITY_PORT` (`CapacityPort`): `poolsForOffering`, `getPool`, `acquireHolds`, `releaseHold`.
- `BASKET_PORT` (`BasketPort`, the finance checkout coordinator, §4.11): `getBasket` (lines with
  price snapshots and policy references), `assertPaymentPermitted` (RESOURCE_CONFLICT
  `APPROVAL_PENDING` while a pending or held line awaits review, SPK-REG-007; `BASKET_INCOMPLETE`
  when a line of an all-or-nothing basket failed or was released after the hold, SPK-REG-004 /
  DEC-026; `NOTHING_HELD` when no line is left), `startCheckout`, `finishCheckout` (the only way a
  `checking_out` basket ends).
- `WAITLIST_PORT` (`WaitlistPort`): `getOffer`, `entriesForPool`, `offerFromPool`.
- `FINANCE_POLICY_PORT` (`FinancePolicyPort` interface): finance registers `FINANCE_POLICY_IMPL`
  (`transferConsequence`, `cancellationConsequence`); until then the consequence is `none`
  (resolved lazily through the kernel's `lazyPort`).
- Fixtures for downstream tests: `testing/enrollment-fixtures.ts` (`createCapacityPoolFixture`,
  `createEnrollmentFixture`, `createHoldFixture`, `createSessionBookingFixture`,
  `createMakeupEntitlementFixture`).

## Outbox handlers

- `enrollment.expire_hold` on `enrollment.hold_expiry_due` (enqueued with `availableAt =
expiresAt`): expires an active hold once due, gives the place back, emits
  `enrollment.capacity_released`, then expires the basket (only while `held`; a checkout keeps its
  pending enrollments for finance), the waitlist offer or the pending session booking.
- `enrollment.offer_waitlist` on `enrollment.capacity_released`: offers free places by priority,
  each offer holding every pool its participant needs until it expires.
- `enrollment.retire_redundant_waitlist_entries` on `enrollment.enrollment_confirmed`,
  `enrollment.enrollment_transferred` (the new enrollment), and `enrollment.session_booked` /
  `enrollment.session_booking_changed` when confirmed: the participant's live entries for what
  they now hold (the same offering, an equivalent entitlement, or the booked session) are
  `removed` with reason `equivalent_entitlement`, an open offer is declined (its places go to the
  next waiter), and offer generation runs again for a free place (SPK-REG-008). Offer generation
  itself also retires such an entry and passes over one whose own registration is still pending.
- `enrollment.expire_makeup` on `enrollment.makeup_expiry_due`.
- `enrollment.sync_capacity` on `catalog.offering_updated`: commercial pools follow catalog limits;
  staffing pools keep their staff count (SPK-YOUTH-002); a limit below commitments raises an
  operational exception.

All are idempotent under replay.

## Events (`enrollment.events.ts`)

`enrollment.application_submitted`, `eligibility_overridden`, `application_decided`,
`application_withdrawn`, `basket_held`, `basket_released`, `basket_fulfilled`, `hold_expiry_due`,
`hold_expired`, `hold_committed`, `hold_released`, `capacity_released`, `capacity_pool_changed`,
`enrollment_created`, `enrollment_confirmed`, `enrollment_canceled`, `enrollment_completed`,
`enrollment_transferred`, `waitlist_joined`, `waitlist_left`, `waitlist_offer_made`,
`waitlist_offer_resolved`, `placement_requested`, `placement_proposed`, `placement_assigned`,
`placement_released`, `session_booked`, `session_booking_changed`, `makeup_issued`,
`makeup_redeemed`, `makeup_expiry_due`, `makeup_changed`, `trial_recorded`, `trial_changed`.
Payloads carry identifiers only (§4.14).

## Behaviour notes — verified

- **Facility scope (§4.3, §4.14):** every application, enrollment, waitlist entry and offer,
  session booking, trial, placement request, basket line and offering pool is authorized at its
  offering's facility (catalog `OFFERING_LOOKUP_PORT.facilitiesOfOfferings`;
  `services/facility-scope.ts`). Facility-scoped staff read, list and change only their
  facilities' records (another facility's customer-private record reads as NOT_FOUND, a list
  filtered by another facility's offering is ACCESS_DENIED); a transfer or trial conversion is
  checked at both offerings, a basket hold, release or completion at every line's facility, a
  makeup at its eligible offerings'. Pools and placement requests without an offering stay
  organization-wide. A staff member who is also the participant or a guardian keeps that own
  authority at every facility (SPK-IAM-001/003). **Verified**, `__tests__/facility-scope.spec.ts`.
- **Eligibility (SPK-REG-002):** pure evaluation (`eligibility/registration-eligibility.ts`) of the
  catalog's versioned eligibility policy at the offering's configured reference date, from the
  identity date of birth (never a stored age); unknown evidence is never a pass; outstanding forms
  are warnings at application and block the hold (MISSING_ACKNOWLEDGMENT). Overrides keep the
  original reasons, the actor and the reason, and are audited. At the hold an override covers only
  the blocking or unknown reasons it recorded, and only for its application's intent: a reason that
  appears later (registration closed or paused, another intent) still fails with
  `ELIGIBILITY_FAILED` (`details.overriddenReasonCodes`); a line never reuses an application made
  for another intent (an accepted one gets a new application; one under review answers 409
  `APPLICATION_INTENT_MISMATCH`). **Verified**, `__tests__/registration-integrity.spec.ts`.
- **Baskets (SPK-REG-004):** all-or-nothing by default; `partial` needs explicit acceptance and
  isolates each line in a savepoint. Each line keeps its own participant, entitlement, eligibility,
  price snapshot, policy references and outcome. The price snapshot is refreshed from the rule
  effective at the hold (an open basket never expires), and `complete` (no checkout) is allowed
  only when every held line owes nothing at the hold and at the rule effective now, counting the
  approved non-inclusive fees and taxes (`PAYMENT_REQUIRED` otherwise; SPK-PAY-001/002).
  `subtotalMinor` stays the sum of base prices. **Verified**,
  `__tests__/registration-integrity.spec.ts`.
- **Current authority (§4.7 (1), SPK-IAM-003/006):** `hold` and `complete` re-check
  `enrollment.manage_basket` over the owner and each line's participant, so a revoked or suspended
  `register` grant stops the hold (a partial basket fails only that line) and the completion.
  Accepting a waitlist offer requires the same authority over the basket owner it names. A
  customer names only themselves (or the basket owner) as payer on baskets, applications,
  waitlist entries, offer acceptance, session bookings, trials and trial conversion; staff may
  name another payer (SPK-REG-009). Unnamed, the payer of an accepted offer is its basket owner,
  and staff must name the owner of a staff-joined entry. **Verified**,
  `__tests__/registration-authority.spec.ts`.
- **Approval (SPK-REG-007):** the eligibility policy, then the organization's `approval` policy
  family (`registration`), then the default intents decide. Holding is allowed; payment capture
  (`assertPaymentPermitted`, `startCheckout`), completion and confirmation wait for the decision.
  Only a line that can still be fulfilled (pending or held) waits; a failed or released line no
  longer blocks the held lines of a partial basket.
- **Assisted registration (SPK-REG-009):** staff use the same commands; the staff actor is stored
  apart from participant, payer and signer; acknowledgments come from catalog with the real signer.
- **Payer privacy (SPK-AT-004):** a second guardian gets DUPLICATE_ENTITLEMENT without learning who
  else registered; their reads show `payerPersonId`, registrant, basket and order as redacted. The
  other household's application blocks while it is under review or has a pending or confirmed
  enrollment; an accepted one whose line was released, removed or abandoned does not (the one
  entitlement is guaranteed by `enrollments_equivalent_active_idx`: the first hold wins). A
  household reuses its own accepted application (its approval or override). Trial participations
  hide a customer registrant the same way (`registeredBy` redacted, `assistedByPersonId` null) on
  `GET /me/trial-participations`, `GET /trial-participations/{id}` and the command responses.
  **Verified**, `__tests__/registration-integrity.spec.ts`, `__tests__/customer-lists.spec.ts`.
- **Checkout ownership (§4.11, SPK-PAY-007):** while a basket is `checking_out`, `release` and
  the cancel of its pending enrollments answer 409 `CHECKOUT_IN_PROGRESS` (with the `orderRef`);
  finance ends it through `finishCheckout('abandoned')` once no attempt can still capture.
- **Late payment (SPK-AT-006):** a hold past its server-owned expiry never commits, even before the
  expiry timer has run (it is expired then and there). A checkout whose hold expired is confirmed
  only by re-acquiring a free place while nobody else waits for the offering (waitlist-first,
  DEC-006); an offer's hold counts in `held`. Otherwise the late payment gets CAPACITY_UNAVAILABLE,
  nothing is written, and finance compensates.
- **Transfers (SPK-REG-010):** the preview shows existing and proposed participation, dates,
  capacity released and required, the waitlist ahead, the finance consequence and approval; commit
  marks the old enrollment `transferred` (its row, confirmation instant and released allocation
  stay as history) and links both ways; it never skips people waiting for the target (DEC-006).
  The accepted refund, credit or charge is recorded on the old enrollment (`transfer_consequence`,
  migration 0501; `transferConsequence`, redacted like the payer), in the audit, the operation
  result and the `enrollment_transferred` payload, and a non-`none` consequence opens an
  operational exception for `finance_operator` (`enrollment.transfer_consequence_pending`) until
  DEC-009 decides how finance settles it. **Verified**, `__tests__/transfer-consequence.spec.ts`.
  Cancellation has the same preview (`cancellation-preview`). A membership, session package,
  rental or party (the intents behind a capability switch) is not transferred: preview and commit
  answer 409 `NOT_TRANSFERABLE`, because a transfer moves none of their lifecycle (term, credits,
  reservation) and their transfer rules are DEC-009; cancel and buy or book the new one.
  **Verified**, `memberships.spec.ts`, `session-packages.spec.ts`.
- **Placement (SPK-PLACE-002/003):** candidates and proposals reserve nothing; assignment
  re-evaluates eligibility, holds a place in every team-entry roster pool configured for the team
  (the same pools a `join_team` registration naming the team holds, SPK-REG-005; **Verified**,
  `__tests__/waitlist-capacity-integrity.spec.ts`), adds the roster
  row through competition's command (which evaluates again), then commits, all under one operation
  and in ONE transaction (competition's command joins it; `UnitOfWork.run` is reentrant), so an
  interruption leaves neither a roster row the pool does not count nor an operation `running`
  (§4.7 invariants 3 and 12; **Verified**, `__tests__/placement-atomic.spec.ts`). Release is one
  transaction in the same way.
- **Pickup (SPK-PLACE-004):** session pools, entry requirements (eligibility and forms), payment
  (pending until finance confirms; free bookings confirm at once, and a booking with an approved
  fee or tax is not free), waitlist and cancellation; no roster or enrollment is ever created.
- **Waitlists (SPK-REG-008):** an entry whose participant now holds what the queue waits for
  leaves it (see `enrollment.retire_redundant_waitlist_entries`), so places are offered only to
  people who can accept them. **Verified**, `__tests__/waitlist-capacity-integrity.spec.ts`.
- **Trials (SPK-AT-019):** a trial is its own record with a trial booking; conversion opens a
  follow-up basket (nothing held, charged or enrolled) that reuses permitted information; the paid
  enrollment links back and marks the trial `converted`, keeping its attendance outcome
  (`attendedAt`, or `noShowAt`, migration 0502). Attendance and no-show are observations: they are
  refused before the trial session starts (400 `VALIDATION_FAILED`, `details.code
trial_not_started`); cancellation stays allowed. **Verified**, `__tests__/youth.spec.ts` and,
  paid through finance, `apps/api/src/__tests__/journeys/spk-at-019.spec.ts`.

## Stage 3 (ENR-01 to ENR-14)

Statements in this section are **verified** by the named tests (PGlite and `TEST_DATABASE_URL`
PostgreSQL) unless marked **proposed** or **pending**.

### Customer reads, paging and views (ENR-01, ENR-02)

- `GET /v1/me/baskets` (the caller's own baskets), `/me/waitlist-entries` (with `offeringName` and
  the `openOffer` and its expiry), `/me/applications`, `/me/trial-participations`: keyset pages
  (created_at desc, id desc) over the people the caller may view (`customerSubjects`, each
  expanded with `personIdsResolvingTo`, so a merged duplicate's history shows under the survivor).
  Migration `0504` adds the read indexes. Tests: `__tests__/customer-lists.spec.ts`
  ("SPK-REG-008: a guardian lists their child's waitlist entries…", "SPK-UX-001: an interrupted
  registration is found from GET /v1/me/baskets after a reinstall").
- `GET /v1/applications`, `/enrollments` and `/placement-requests` honour `cursor`/`nextCursor`.
  An enrollment carries `offering` (name, kind, dates, facility and its IANA zone, also for closed
  offerings) and `pendingReason` (`approval`, `forms`, `payment`, `placement`); family calendar
  items carry `facilityId` and `timezone`; a placement request carries `assignedTeamName`.
  Tests: "SPK-UX-004: a pending enrollment states what is outstanding", "SPK-SCHED-008: family
  calendar items carry the facility time zone".

### Commands (ENR-03 to ENR-06)

- `GET /v1/enrollments/{id}/transfer-preview` (read only). Cancel and transfer bind the previewed
  consequence: `acceptedConsequence` must match the current one (`CONSEQUENCE_ACCEPTANCE_REQUIRED`,
  `CONSEQUENCE_CHANGED`); `commit: false` and `acceptConsequence` are deprecated. A target the
  public catalog does not show (draft, unpublished) answers protected NOT_FOUND to anyone but staff
  who transfer at its facility, before any of its facts are computed (§4.10, as registration
  options do). `__tests__/transfer-consequence.spec.ts`, `registration-commands.spec.ts`.
- `POST /v1/waitlist-entries/{id}/offer` (program administration): offers the place to the next in
  queue only (`NOT_NEXT_IN_QUEUE` names who is), `CAPACITY_UNAVAILABLE` without a free place;
  the same offer payload as the generator.
- `GET /v1/offerings/{id}/registration-options?participantPersonIds=`: the intents an offering
  takes and a read-only evaluation per participant (customers: public offerings only).
- The finance checkout operation is recorded as `last_operation_id` on the basket and its pending
  enrollments (SPK-UX-001).

### Follow-ups (ENR-07 to ENR-09)

- `enrollment.follow_person_merge` (identity.persons_merged): pairs the survivor's and the merged
  person's live records a partial unique index would have refused for one person and raises one
  `enrollment.merged_duplicate_entitlement` (owner `program_manager`) per pair; nothing is
  canceled automatically. `__tests__/follow-ups.spec.ts`.
- Periodic job `enrollment.reconcile_placements` (60 s, failure owner `program_manager`;
  technical setting `ENROLLMENT_PLACEMENT_RECONCILE_AFTER_SECONDS`, default 300): a placement
  assignment whose operation stayed `running` is completed when the roster already holds the
  player, else its holds are released, the operation fails and
  `enrollment.placement_interrupted` is raised.
- Notices composed by enrollment in the handler transaction with the event id as `sourceEventId`
  (IF-22; one per event, replays compose nothing): `waitlist_offer` (expiry in the facility's local
  time), `placement` (team name), `registration_outcome`.

### Package G behind capability switches (ENR-10 to ENR-14)

Each capability is off by default per organization and changed only by an administrator with
audit (K-12). Whether the complex uses it is **pending** (DEC-016 and the decision named below).
A disabled capability refuses new commitments with 403 `ACCESS_DENIED`, `details.code`
`CAPABILITY_DISABLED`; reads, cancellations, reversals, suspensions, expiry jobs, staffing
follow-ups and payment outcomes never check it. Policy values (prices, expiry, credit return,
benefits, terms, deposits) are configuration in the catalog; nothing here supplies a default.

| Capability          | Decision                            | Gated here                                                                               | Migration  | Tests                                                       |
| ------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------- | ---------- | ----------------------------------------------------------- |
| `pickup_sessions`   | DEC-016, DEC-082                    | a new pickup booking (`POST /v1/session-bookings`)                                       | —          | `package-g-foundation.spec.ts`                              |
| `memberships`       | DEC-016, DEC-072                    | membership lines, membership bookings, renewal                                           | 0505, 0507 | `package-g-foundation.spec.ts`, `memberships.spec.ts`       |
| `session_packages`  | DEC-016, DEC-074                    | package purchase lines, redemption (`packageEntitlementId`)                              | 0505, 0506 | `package-g-foundation.spec.ts`, `session-packages.spec.ts`  |
| `rentals`           | DEC-016, DEC-076                    | `POST /v1/bookings` and approval of a rental                                             | 0508, 0512 | `bookings.spec.ts`                                          |
| `parties`           | DEC-016, DEC-077                    | `POST /v1/bookings` and approval of a party                                              | 0508, 0512 | `bookings.spec.ts` (party case needs CAT-02's `party` kind) |
| `youth_progression` | DEC-016 (DEC-003, DEC-054, DEC-055) | template drafting/approval, assessment authoring/review, recommendation drafting/sharing | 0509–0511  | `youth-progression.spec.ts`                                 |

Every basket entry point finance calls (`hold`, `complete`, `assertPaymentPermitted`,
`startCheckout`) re-checks every live line's capability before any payment attempt ("DEC-016:
checkout of a held package line after session_packages was disabled is refused before any payment
attempt"). A plain `rental_request` or `party_request` line is refused with `BOOKING_REQUIRED`;
membership and package lines are one entitlement (`QUANTITY_ONE`; migration 0505 check). The
module-local lifecycles are in `enrollment.state-machines.ts` (DEC-093 **proposed**), each
mirrored by a database transition guard.

- **Session packages (ENR-11, SPK-COND-002, SPK-AT-020).** A confirmed `package_purchase` issues
  one `package_entitlements` row with the definition's credits and expiry (`none`,
  `days_after_issue`, `fixed_date` → the next local midnight after it); an unreadable scope issues
  nothing and raises `enrollment.package_scope_invalid`. `POST /v1/session-bookings` with
  `packageEntitlementId` books a covered session and records the redemption in one unit of work;
  the `package_redemptions_apply` trigger (row lock, `redeemed_count <= credits`) is the guarantee:
  two concurrent redemptions of the last credit leave one booking (PGlite and PostgreSQL). A
  canceled package booking returns its credit only as the package's approved cancellation policy
  says (`packageCreditReturn.untilMinutesBeforeStart`: `returned`), else `retained_by_policy`, or
  `retained_pending_policy` when no policy states it (POL-007, POL-039). Staff reverse a redemption
  (`POST /v1/package-redemptions/{id}/reverse`, ungated). A canceled purchase revokes the package;
  future bookings stay and raise `enrollment.revoked_package_has_bookings`. Job
  `enrollment.expire_package_entitlements`. Reads: `GET /v1/me/package-entitlements`,
  `GET /v1/package-entitlements`.
- **Memberships (ENR-12, SPK-COND-001).** The term is set when the membership is confirmed
  (`offering_dates` in the facility zone or `from_confirmation` plus `lengthDays`; an unreadable
  term books nothing and raises `enrollment.membership_term_unknown`). Attendance is exactly what
  the definition states: `none` books nothing, `included_sessions` books covered sessions in the
  term and outside active suspensions, counted per `week:<first local date>`, `month:<YYYY-MM>` or
  `term` (`membership_benefit_uses`, `used_count <= limit_count`), `unlimited` books without a
  count. A membership never admits at check-in by itself: entry admits through the session
  booking (verified with the entry module). Member-only eligibility (`membershipRequired` in the
  eligibility policy) is the known reason `MEMBERSHIP_REQUIRED`. Suspensions
  (`POST /v1/enrollments/{id}/membership-suspensions`, `/membership-suspensions/{id}/end`; active
  periods never overlap: exclusion constraint), renewal (`POST /v1/enrollments/{id}/renew` adds a
  linked membership line; nothing is charged until checkout), job `enrollment.membership_lifecycle`
  (completes ended terms, ends elapsed suspensions, one `renewal_opportunity` notice when the
  definition sets `renewal.noticeLeadDays`), `GET /v1/me/memberships`.
- **Rentals and parties (ENR-13, SPK-COND-003).** `POST /v1/bookings` validates the offering's
  approved booking terms (`BOOKING_TERMS_REQUIRED`), its resources (exact count from the allowed
  set), guests (party) and equipment (`EQUIPMENT_UNAVAILABLE` through `ASSET_DIRECTORY_PORT`).
  Instant mode reserves the event or weekly series (every conflict first; a taken slot writes
  nothing), declares must-be-accepted staffing on every event, and opens the basket line with a
  server-owned hold on a one-place pool for the booking, all in one unit of work. Request mode
  (DEC-029, POL-005) only checks availability and raises `enrollment.booking_request_pending`
  (owner `scheduler`); approval reserves, decline ends it. After payment the booking is
  `confirmed` only when every staff slot is covered, else `awaiting_staff` with
  `enrollment.booking_awaiting_staff` (owner `scheduler`); `workforce.assignment_changed`
  re-evaluates both ways. Hold expiry expires an unpaid booking and cancels its events; cancel
  releases what the state holds (a paid booking through the enrollment cancellation with the
  accepted consequence) and withdraws the staffing of exactly the occurrences it cancels: an
  occurrence that already started keeps its events, requirements and accepted assignments, so the
  work done can still be completed (SPK-SCHED-007); a held booking whose basket is in checkout answers 409
  `CHECKOUT_IN_PROGRESS`, and one whose basket is already paid but not yet confirmed 409
  `BOOKING_CONFIRMATION_PENDING`, before anything is written (§4.11). Job `enrollment.booking_lifecycle` (failure owner `scheduler`):
  undecided requests expire at their start, an unstaffed booking that starts raises the critical
  `enrollment.booking_started_unstaffed`, ended bookings complete. Reads:
  `GET /v1/offerings/{id}/booking-availability`, `/v1/me/bookings`, `/v1/bookings/{id}` (booker or
  staff; anyone else NOT_FOUND), `/v1/bookings` (staff). `BOOKING_QUERY_IMPL` is provided (IF-36).
- **Youth progression (ENR-14, SPK-YOUTH-005, SPK-YOUTH-006; owner Proposed).** Approved
  templates (program managers) name skill areas and an ordinal scale; the
  `assessments_template_guard` trigger refuses an unapproved template, an unknown skill area or a
  value off the scale. Program managers, or a coach accepted on the offering (IF-34), author
  assessments of enrolled participants; a program manager other than the author approves them
  (`assessments_reviewer_differs`): family rows are published, staff-only rows recorded, both then
  immutable; while submitted, the content the reviewer approves is fixed too
  (`assessments_submitted_content_fixed`, 0511). A correction is a new row
  (`correctsAssessmentId`) that requires `reason` (§4.9; stored as `correctionReason`, refused by
  `assessments_correction_reason` without one, and audited with the corrected id); an assessment
  has at most one live correction (`assessments_one_live_correction_idx`, 409 `ALREADY_CORRECTED`),
  so a later correction corrects the correction. `GET /v1/me/youth-feedback` shows only published
  family feedback that no published or recorded correction replaces, and shared recommendations,
  never staff or review notes; one `youth_feedback` notice per published assessment or shared
  recommendation carries no staff content. A shared recommendation's content is fixed and a
  withdrawn one never changes (`progression_recommendations_content_fixed`, 0511). **Verified**,
  `__tests__/youth-progression.spec.ts`.
  `GET /v1/participants/{personId}/assessments` is the staff view: a program manager sees the
  offerings in their facility scope and gets an empty page when nothing is visible, whatever exists
  at other facilities; a coach sees offerings they are accepted on, and NOT_FOUND otherwise (§4.10).
  A recommendation stores the read-only eligibility of the recommended offering and never holds
  capacity.

### Test doubles (`__tests__/stage3-doubles.ts`)

Stage-3 port members other work items implement (ID-01, ID-04, CMP-01, SCH-02, WRK-02, WRK-03;
CAT-02 booking terms) answer through their declared contract in these tests only while the real
member is still `declaredNotImplemented`; once merged the tests run against the real
implementation. Typed Package G scopes are written in the shape CAT-02 validates
(`__tests__/package-g-support.ts`); enrollment parses them again at the point of use
(`package-g/scopes.ts`) and refuses rather than guesses when they do not match.

## Policy defaults (proposed, pending operator decisions §6.6)

`enrollment.policy.ts` (`DEFAULT_ENROLLMENT_POLICY`): hold 10 minutes (DEC-027); waitlist offer 48
hours (engineering placeholder, DEC-006); an expired offer requeues at the end (DEC-006);
waitlist-first while anyone waits (DEC-006); approval intents `join_team`, `create_team_entry`
(DEC-028); approval does not reserve capacity (DEC-029); household fulfillment all-or-nothing
(DEC-026); placement is staff-reviewed by league administration (DEC-031). Family calendar windows
are at most 120 days.

## Known gaps

- SPK-YOUTH-005/006 are implemented behind `youth_progression` with enrollment as **proposed**
  owner; templates, scales, family-visible feedback and recommendation inputs remain **pending**
  (DEC-003, DEC-054, DEC-055).
- **Pending on this branch, closed at integration:** the migration module's record-authority test
  (MIG-00) lists write routes statically, so the stage-3 routes decorated here
  (`@RecordAuthority`, `@NoRecordAuthority`) are reported until MIG-00 is merged; and
  `docs/api/openapi.json` is regenerated by the integrator, so the served-vs-documented parity test
  reports it stale on this branch.
- A booking's deposit (the first installment of the terms' `installmentPolicyKey`) is finance's
  checkout concern; enrollment records the terms version on the line (`policyReferences.
bookingTermsPolicyVersionId`). **Pending** finance (FIN) and DEC-073.
- Withdrawing staffing requirements on booking cancellation and the real requirement declaration
  are WRK-02's; on this branch they run through the test double only.
- `approvalReservesCapacity` (DEC-029) is configuration only; an approval never takes a hold.
  Deposit-before-approval workflows (DEC-030) are not supported.
- `join_team` and `create_team_entry` enrollments hold roster-place / team-entry capacity (a
  `join_team` line the offering's `roster_places` pools and the named team entry's `roster_places`
  pools). **Verified** (SPK-AT-002, `apps/api/src/__tests__/journeys/spk-at-002.spec.ts`): a
  `join_team` line is evaluated against competition's player eligibility for the entry
  (`ELIGIBILITY_PORT`, restricted reasons, source `team_entry`) before approval, quote or payment,
  and confirming a `join_team` enrollment places the player on the roster through
  `RosterPort.addRegisteredMember` in the confirming transaction (source `registration`; the audit
  records name each other). A refusal at confirmation fails the confirmation, so finance keeps the
  payment visible as `recovery_required`. Still open: `create_team_entry` creates no team entry;
  cancelling or transferring a confirmed `join_team` enrollment does not end its roster membership;
  payment on invitation or join-request acceptance follows the billing model (**Pending decision**
  DEC-008). Offerings carry no season, so a `join_team` line is not checked against the team
  entry's season.
- SPK-AT-009 (**Verified**, `__tests__/journeys/spk-at-009.spec.ts`): `SessionParticipants` answers
  who takes part in the catalog sessions behind scheduling events (live enrollments of the offering,
  live bookings of the session). It is communications' `SESSION_AUDIENCE_IMPL` (change notices reach
  those participants' guardians) and a closure impact contributor (customers, and the orders they
  paid through).
- Makeups are issued by staff (with the originating session); automatic issue on
  `catalog.session_canceled` awaits the makeup rules (DEC-003). Package-credit redemption
  (invariant 7 for packages) is enrollment's (ENR-11, above).
- Pickup organizer assignment (workforce) and attendance (entry) are other modules' records.
- The money side of a non-`none` transfer or cancellation consequence is finance's. Both are
  recorded here as facts (`cancellation_consequence`, `transfer_consequence`), and a transfer's
  also opens a `finance_operator` exception. Finance registers `FINANCE_POLICY_IMPL`
  (`FinancePolicyAdapter`), which computes the consequence from the approved policy; nothing
  executes the refund, credit or charge automatically yet, and whether a charge keeps the new
  place pending until paid is pending DEC-009 (finance README, "Known gaps"). The consequence is
  computed from the enrollment's base price snapshot, not from what the order actually charged
  (discounts, fees): **pending DEC-009**.
- A `register` grant revoked while a basket is already held (the hold window) is not re-checked
  when finance starts the checkout; finance's own `pay` check over each participant applies there.
- A session booking whose hold expired is expired by the timer even while a checkout is running
  (baskets keep their pending enrollments for finance instead); a late booking payment is
  compensated by finance.
- `GET /v1/applications`, `/enrollments`, `/placement-requests` and every `/me/*` list are cursor
  pages; waitlist, session-booking and makeup lists still return one page.

## Kernel limitations worked around here

- Outbox handlers receive the dispatcher's transaction but not the kernel's transaction context;
  the module binds it with `runWithTransaction` so port reads go through it.
- Catalog's `SessionsService.list` reads through the root database, which waits forever for the
  single PGlite connection inside a transaction; sessions are read before or after transactions
  (`services/catalog-sessions.ts` refuses to run inside one).
- Competition's `RosterService.changeRoster` is called inside placement's transaction; its unit
  of work joins it (the kernel's `UnitOfWork.run` is reentrant).

## Stage-3 integration notes — verified 2026-10-29

- A booking's deposit is now quoted by finance from the approved installment policy its terms name
  (finance README, "Stage-3 integration fixes"; journey `spk-cond-003-rentals.spec.ts`): the
  earlier "**Pending** finance (FIN)" note is resolved; DEC-073 (the deposit rule itself) is still
  **Pending decision**.
- Booking staffing requirements are declared and retired through workforce's implementation
  (WRK-02), not the test double: the earlier "test double only" note is resolved (journey
  `spk-cond-003-party-booking.spec.ts`: an expired hold retires the requirement, which leaves Today
  and the uncovered-assignments report).
- The module now imports `SchedulingModule`, `CommunicationsModule`, `WorkforceModule` and
  `FacilitiesModule` (bookings, notices, staffing, equipment); the record-authority classification
  and OpenAPI parity notes above were closed at integration (both tests pass).
- Journeys over this module: `spk-cond-001` to `spk-cond-003`, `capability-switches`,
  `spk-reg-008-waitlist-offer`, `spk-youth-005-progression`, `spk-at-023-interrupted-payment` in
  `apps/api/src/__tests__/journeys/`.
