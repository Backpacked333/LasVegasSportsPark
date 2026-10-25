# enrollment module

**Owns:** applications, enrollments, household baskets and basket lines, placement requests,
session bookings, capacity pools, holds, allocations, waitlist entries and offers, makeup
entitlements and their redemption history, trial participations

**Specification:** §3.3 (SPK-REG-001..010), §3.6 (SPK-PLACE-001..005), §3.13 (SPK-YOUTH-001..004,
SPK-YOUTH-007), §4.4 Participation (Application, Enrollment, PlacementRequest, SessionBooking) and
Capacity (CapacityPool, Hold, Allocation, WaitlistEntry, WaitlistOffer), §4.5, §4.6 Application /
Enrollment / Placement / Hold / SessionBooking machines, §4.7 invariants 2, 3, 7, §4.8
(`POST /v1/enrollments/{id}/transfer`, `POST /v1/waitlist-offers/{id}/accept`), SPK-AT-001, 004,
005, 006, 015 (precondition), 019, 020

**Migration range:** `packages/db/migrations/0500_enrollment_*.sql` … `0599` (this module uses `0500`)

**Depends on:** identity (`PERSON_DIRECTORY_PORT` for participants, `RelationshipAuthority` for the
family calendar's current grants), catalog (`OFFERING_LOOKUP_PORT`, `POLICY_PORT`, `PRICING_PORT`,
`SessionsService`), competition (`TEAM_ENTRY_QUERY_PORT`, `ELIGIBILITY_PORT`, `ROSTER_PORT`, and
`RosterService.changeRoster` for placement roster additions). It never writes another module's
tables (§4.2).

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
| POST     | `/baskets/{id}/hold`, `/release`, `/complete`                                                             | same; `hold` creates an operation; `complete` only for baskets that owe nothing                                    |
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
  price snapshots and policy references), `assertPaymentPermitted` (SPK-REG-007:
  RESOURCE_CONFLICT `APPROVAL_PENDING`), `startCheckout`, `finishCheckout`.
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

- **Eligibility (SPK-REG-002):** pure evaluation (`eligibility/registration-eligibility.ts`) of the
  catalog's versioned eligibility policy at the offering's configured reference date, from the
  identity date of birth (never a stored age); unknown evidence is never a pass; outstanding forms
  are warnings at application and block the hold (MISSING_ACKNOWLEDGMENT). Overrides keep the
  original reasons, the actor and the reason, and are audited.
- **Baskets (SPK-REG-004):** all-or-nothing by default; `partial` needs explicit acceptance and
  isolates each line in a savepoint. Each line keeps its own participant, entitlement, eligibility,
  price snapshot, policy references and outcome.
- **Approval (SPK-REG-007):** the eligibility policy, then the organization's `approval` policy
  family (`registration`), then the default intents decide. Holding is allowed; payment capture
  (`assertPaymentPermitted`, `startCheckout`), completion and confirmation wait for the decision.
- **Assisted registration (SPK-REG-009):** staff use the same commands; the staff actor is stored
  apart from participant, payer and signer; acknowledgments come from catalog with the real signer.
- **Payer privacy (SPK-AT-004):** a second guardian gets DUPLICATE_ENTITLEMENT without learning who
  else registered; their reads show `payerPersonId`, registrant, basket and order as redacted.
- **Late payment (SPK-AT-006):** a hold past its server-owned expiry never commits, even before the
  expiry timer has run (it is expired then and there). A checkout whose hold expired is confirmed
  only by re-acquiring a free place while nobody else waits for the offering (waitlist-first,
  DEC-006); an offer's hold counts in `held`. Otherwise the late payment gets CAPACITY_UNAVAILABLE,
  nothing is written, and finance compensates.
- **Transfers (SPK-REG-010):** the preview shows existing and proposed participation, dates,
  capacity released and required, the waitlist ahead, the finance consequence and approval; commit
  marks the old enrollment `transferred` (its row, confirmation instant and released allocation
  stay as history) and links both ways; it never skips people waiting for the target (DEC-006).
  Cancellation has the same preview (`cancellation-preview`).
- **Placement (SPK-PLACE-002/003):** candidates and proposals reserve nothing; assignment
  re-evaluates eligibility, holds a team-entry roster place when one is configured, adds the roster
  row through competition's command (which evaluates again), then commits, all under one operation
  and in ONE transaction (competition's command joins it; `UnitOfWork.run` is reentrant), so an
  interruption leaves neither a roster row the pool does not count nor an operation `running`
  (§4.7 invariants 3 and 12; **Verified**, `__tests__/placement-atomic.spec.ts`). Release is one
  transaction in the same way.
- **Pickup (SPK-PLACE-004):** session pools, entry requirements (eligibility and forms), payment
  (pending until finance confirms; free bookings confirm at once), waitlist and cancellation; no
  roster or enrollment is ever created.
- **Trials (SPK-AT-019):** a trial is its own record with a trial booking; conversion opens a
  follow-up basket (nothing held, charged or enrolled) that reuses permitted information; the paid
  enrollment links back and marks the trial `converted`, keeping its attendance.

## Policy defaults (proposed, pending operator decisions §6.6)

`enrollment.policy.ts` (`DEFAULT_ENROLLMENT_POLICY`): hold 10 minutes (DEC-027); waitlist offer 48
hours (engineering placeholder, DEC-006); an expired offer requeues at the end (DEC-006);
waitlist-first while anyone waits (DEC-006); approval intents `join_team`, `create_team_entry`
(DEC-028); approval does not reserve capacity (DEC-029); household fulfillment all-or-nothing
(DEC-026); placement is staff-reviewed by league administration (DEC-031). Family calendar windows
are at most 120 days.

## Known gaps

- SPK-YOUTH-005 (development records) and SPK-YOUTH-006 (progression recommendations) are not
  implemented: §4.4 names no entity for them and their owning module and criteria are undecided
  (DEC-003).
- `approvalReservesCapacity` (DEC-029) is configuration only; an approval never takes a hold.
  Deposit-before-approval workflows (DEC-030) are not supported.
- `join_team` and `create_team_entry` enrollments hold roster-place / team-entry capacity but do
  not create roster rows or team entries; competition's join requests, invitations and
  `POST /team-entries` do (placement is the one flow that adds a roster row).
- Makeups are issued by staff (with the originating session); automatic issue on
  `catalog.session_canceled` awaits the makeup rules (DEC-003). Package-credit redemption
  (invariant 7 for packages) belongs to finance/entry.
- Pickup organizer assignment (workforce) and attendance (entry) are other modules' records.
- The money side of a non-`none` transfer or cancellation consequence is finance's (recorded here
  as a fact). Finance registers `FINANCE_POLICY_IMPL` (`FinancePolicyAdapter`), which computes the
  consequence from the approved cancellation policy; nothing executes the refund, credit or charge
  automatically yet (finance README, "Known gaps").
- A session booking whose hold expired is expired by the timer even while a checkout is running
  (baskets keep their pending enrollments for finance instead); a late booking payment is
  compensated by finance.
- List endpoints return one page (`nextCursor: null`); cursor pagination is pending.

## Kernel limitations worked around here

- Outbox handlers receive the dispatcher's transaction but not the kernel's transaction context;
  the module binds it with `runWithTransaction` so port reads go through it.
- Catalog's `SessionsService.list` reads through the root database, which waits forever for the
  single PGlite connection inside a transaction; sessions are read before or after transactions
  (`services/catalog-sessions.ts` refuses to run inside one).
- Competition's `RosterService.changeRoster` is called inside placement's transaction; its unit
  of work joins it (the kernel's `UnitOfWork.run` is reentrant).
