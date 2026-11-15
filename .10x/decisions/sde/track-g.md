# SDE hand-off: Track G (the demo dataset and tours)

Feature `glass-demo-amendments`, ADR-007. Status words follow §6.7: **Verified**, **Proposed**,
**Pending decision**. The ten amendments stay **Proposed** and their values **Pending decision**
(DEC-095 to DEC-104); every price, limit, wording and name in the dataset is a sample value, never
a policy default. What is described as built is **Verified** by the tests and the run named in
section 6.

## 1. What was built

- `apps/api/src/dev/seed-demo.ts` (`seedDemo`) and its stages under `apps/api/src/dev/demo/`:
  `context.ts` (principals, the facility calendar, the follow-up loop), `people.ts`, `spaces.ts`,
  `catalog.ts`, `registrations.ts`, `league.ts`, `messages.ts`, `rentals.ts`, `register.ts`,
  `assignments.ts`, `reports.ts`. Script `apps/api/scripts/seed-demo.ts`; `seed:demo` in
  `apps/api/package.json` (the only `package.json` change). No dependency was added and the
  lockfile is untouched.
- `scripts/demo.mjs`: seeds with `seed:demo` (the seed enables the capabilities from
  `CAPABILITY_IDS`; the hand-written list is gone), starts `dist/dev-all.js` (the API with the
  worker's loops in one process) instead of `dist/main.js`, passes the accounts and the tour links
  to the dashboard (`VITE_DEMO_ACCOUNTS`, `VITE_DEMO_LINKS`) and the organization slug to the
  mobile app, waits for the API and prints the dashboard, lobby and public addresses.
- `apps/staff/src/demo/`: `links.ts` (new), `roles.ts` (tours rewritten against the dataset; a
  sixth staff role, general manager), `TourPanel.tsx` and `DemoRolePicker.tsx` (a step opens its
  seeded record, public pages open in a new tab), the test.
- `apps/mobile/src/demo/tour.ts` and its test: five new steps.
- Tests: `apps/api/src/dev/__tests__/seed-demo.spec.ts` (13), the staff demo test (16), the
  mobile demo test (9).
- `README.md`, section "Real and demo modes".

## 2. What the dataset contains and which service creates each piece

Principals: `dev-admin` enables the capabilities; `demo-manager` (created here: general manager,
program manager, finance operator, scheduler, facilities operator) sets the facility up;
`dev-league` runs the league and the messages; `dev-desk` works the desk; parents, renters and
captains act for themselves. The system principal is used only for identity records (people,
accounts, staff memberships, households, relationships), as `seed-dev.ts` does.

| Piece                                                                                             | Created through                                                                                                                                               | Found again by                         |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| 25 capabilities on, each on its own applicability decision                                        | `CapabilityService.change`                                                                                                                                    | `CapabilityService.list`               |
| Staff: general manager, a second coach, a second official; an email for the six seeded accounts   | `PeopleService.createPerson`, `addContactPoint`, `AccountsService.createAccount`, `StaffMembershipsService.create`                                            | account subject (`PrincipalResolver`)  |
| 11 families (an adult, one or two children, a household) and the seeded parent's household        | the same, `RelationshipsService.ensureAuthority`, `HouseholdsService`                                                                                         | subject; child name under the guardian |
| 32 league players, 3 more captains, 4 renters                                                     | the same                                                                                                                                                      | account subject                        |
| Field 1 with two halves, Fields 2 and 3, Court, Party room; opening hours                         | `ResourcesService.createConflictUnit`, `createResource`, `createOperatingHours`                                                                               | resource name                          |
| A goal net asset and a maintenance task; a planned closure of Field 3                             | `AssetsService.create`, `MaintenanceTasksService.reportIssue` (as the desk), `ClosuresService.createClosure`                                                  | asset name, closure reason             |
| Policies: eligibility, eligibility by approval, cancellation, waiver, rental terms (all approved) | `PoliciesService.createPolicyVersion`, `approve`                                                                                                              | kind and key                           |
| Entitlement definitions: seat, membership benefit, rental resource                                | `EntitlementDefinitionsService.create`                                                                                                                        | name                                   |
| 3 programs, 8 offerings (7 published with registration open, 1 draft)                             | `ProgramsService.create`, `OfferingsService.create`, `publish`, `openRegistration`                                                                            | name                                   |
| 43 sessions on the calendar                                                                       | `EventSeriesService.createSeries` (weekly or daily, on a space, with the coach), then `SessionsService.create` per event                                      | created with the offering              |
| Prices: term, per session, member price, camp tiers                                               | `PriceRulesService.create`                                                                                                                                    | created with the offering              |
| Camp add-ons (lunch, early drop-off, team photo with 6 places) and jersey                         | `OfferingExtrasService.createAddon`, `createUniform`                                                                                                          | created with the offering              |
| The waiver required on every published offering                                                   | `WaiversService.setOfferingRequiredWaivers`                                                                                                                   | created with the offering              |
| Waiver acceptances: 12 digital, 1 from paper (by the desk), 2 children without                    | `WaiversService.accept`                                                                                                                                       | `WaiversService.personWaivers`         |
| 16 registrations: basket, hold, quote, checkout (card through the fake provider, or cash)         | `BasketsService.create`, `addLine`, `hold`; `QuotesService.create`; `CheckoutService.create`                                                                  | `EnrollmentsService.list`              |
| A declined card and a payment with an unknown outcome                                             | the same with the fake provider's `decline` and `timeout` tokens                                                                                              | `ApplicationsService.list`             |
| A waitlist entry; two applications awaiting approval                                              | `WaitlistService.join`, `ApplicationsService.create`                                                                                                          | their lists                            |
| A canceled registration (finance exception) and its refund still with the provider                | `EnrollmentsService.cancellationPreview`, `cancel`; `RefundsService.request` with the fake provider scripted to answer `processing`                           | enrollment status; `listRefunds`       |
| An amount the seeded parent owes                                                                  | `ObligationsService.create`                                                                                                                                   | its description                        |
| Rule set, two competitions (one never set up further)                                             | `CompetitionsService.createRuleSet`, `create`                                                                                                                 | name                                   |
| 4 message templates, a season sequence with 4 steps, switched on **before** the season exists     | `MessageTemplatesService.create`, `MessageSequencesService.create`, `addStep`, `update`                                                                       | name                                   |
| The season (open, then active) and two divisions                                                  | `SeasonsService.createSeason`, `updateSeason`, `createDivision`                                                                                               | name                                   |
| 8 approved team entries with rosters; 2 waiting; 1 applied                                        | `TeamEntriesService.create` (by the league manager for the captain), `approve`; `RosterService.changeRoster`                                                  | team name                              |
| The open place offer                                                                              | `SeasonsService.updateDivision` (capacity 4 to 5), `TeamWaitlistService.offer`                                                                                | `offersOfEntry`                        |
| 24 fixtures                                                                                       | `FixtureGenerationService.createSpecification`, `generate`; `ScheduleDraftsService.publish`                                                                   | `FixturesService.listForSeason`        |
| 10 published results, 2 submitted; a dispute by a captain                                         | `ResultsService.submit`, `publish`; `DisputesService.create`                                                                                                  | `listForFixture`; `list`               |
| The season's schedule: one sent, one skipped, two waiting                                         | produced by `competition.season_created`; `MessageScheduleService.confirm`, `skip`; `ScheduledMessageSender.run` once                                         | message status                         |
| Public competition and the facility's public day schedule                                         | `PublicCompetitionService.publish`, `PublicScheduleService.enable`                                                                                            | `publication`, `view`                  |
| 3 rental bookings (2 paid, 1 unpaid)                                                              | `BookingsService.create`, then quote and checkout                                                                                                             | booker and start                       |
| The roster: 2 joined, 2 invitations (one to the seeded parent)                                    | `BookingRostersService.addMember`, `invite`                                                                                                                   | `roster`                               |
| 6 products, a register, an open session, 5 sales, 3 open-amount lines, 1 approval                 | `PosSetupService.createProduct`, `createRegister`, `openSession`; `PosSalesService.create`, `addLine`, `addTender`; `PosOpenAmountService.addLine`, `approve` | sku, register code, session sales      |
| 5 assignments (coach 3, official 2)                                                               | `AssignmentsService.create`, `accept`                                                                                                                         | `list` by person                       |
| 3 stored report runs                                                                              | `ReportRunsService.create`                                                                                                                                    | `list` by report                       |

Services that their module does not export from `index.ts` are imported from the module's own
file, because their command exists only behind a controller: `TeamWaitlistService`,
`PublicCompetitionService`, `BookingsService`, `BookingRostersService`, `ReportRunsService`.

After each stage the seed runs the inbox and the outbox until nothing is due (`settle`), as a
worker would; that is what produces the notices, the message schedule and the standings.

Idempotency: a second run changes no table (the test counts the rows of every table). Top-level
records are found by natural key; what is created with a parent (sessions, the price rule and the
extras of an offering, a roster) is created only when the parent was. A run that stopped half way
through a stage is therefore not repaired by running again: start again with `pnpm demo --fresh`.

## 3. What could not be created, and why

- **A coach's uniform list** (asked for in the coach's tour). `GET /v1/uniform-orders` needs
  `enrollment.read_uniform_orders`, whose roles do not include `coach`; the coach is answered 403.
  The uniform list is a step of the front desk tour instead. Whether a coach may read the list
  for their own team or class is a **Pending decision**.
- **A team-season uniform.** The uniform is on the camp. Track D ties a team uniform to the league
  offering its teams register through; the demo league has no registration offering.
- **Results in "Results review".** That screen lists only review tasks of a correction that would
  change a bracket; a league without a bracket never raises one. The two reported scores are on
  the season's results page, which is where the tour now goes.
- **Fee records for the official, player assessments for the coach, a facility pass.** A fee
  needs a completed assignment and DEC-011 rates; assessments need templates (youth progression);
  the customer app issues a pass itself when the Pass screen is opened.
- **Tournaments, parties, session packages, pickup sessions, installments, access hardware, the
  assistant.** Their capabilities are on (all are), nothing is seeded for them.
- **A check-in today.** Nothing is recorded as arrived; the arrival screen works on look-ups.
- **A message schedule for an offering.** Only the season has a sequence.
- **`Dev Child` keeps the name the development seed gave it;** the dataset only adds a date of
  birth (a class with an age band needs one) and a household.

## 4. Bugs and rough edges found by running the features together

Each was found by the seed, the spec or the real run. None was patched in a module.

1. **A price cannot be made effective now.** `PriceRulesService.create`
   (`catalog/services/price-rules.service.ts`, the check after `const now = this.clock.now()`)
   refuses `effectiveFrom < now`, and its `now` is read after the caller's. With a clock that
   moves, a caller that sends its own current instant is always refused: `POST
/v1/offerings/{id}/price-rules` with `effectiveFrom: new Date().toISOString()` answers 400
   "effectiveFrom must be at or after now". Every test that does this uses a fixed clock, which
   hides it. The staff form takes a local date and time, so "this minute" is refused too. And
   because an offering is published only with a price in effect, an operator cannot enter a price
   and publish in one sitting without choosing a future minute and waiting. The seed sends an
   instant 400 ms ahead and waits (`soon`, `waitUntil` in `demo/context.ts`). Suggested: accept an
   instant within a small tolerance of now, or an explicit "from now".
2. **The front desk cannot list a waitlist.** `WaitlistService.list`
   (`enrollment/services/waitlist.service.ts`) requires `enrollment.manage_waitlist`, while
   `enrollment.read_waitlist` exists, includes `front_desk` and guards the single-entry reads.
   `GET /v1/waitlist-entries?offeringId=<id>` as `dev-desk` answers 403; the staff screen
   `/registrations/waitlists/:offeringId` is therefore closed to the desk.
3. **No role of the original role picker could approve an open-amount line or see the money
   side.** Approval needs `finance_operator` or `general_manager`; the finance exception queue
   answers "This queue is outside your scope" to the front desk; `reporting.view_financial_reports`
   excludes `system_administrator`, so the administrator's `GET /v1/reports/runs` lists only the
   registration funnel and never the sales report with the open-amount lines. All by the
   permission model, but it left the amendment's approval step and the finance data unreachable in
   the demo. A general manager role was added to the picker (section 1).
4. **"Results review" is not where reported scores wait** (section 3). The earlier tour copy
   said they did.
5. **Every notice to a person without an email address is an exception for the front desk.** The
   six accounts of the development seed have no contact point. On the first real run with the
   worker, 31 `communications.delivery_failed` (NO_ADDRESS) exceptions opened in the front desk
   queue within a minute, one per notice and recipient, and filled Today. The dataset now gives
   those accounts `<subject>@example.test`. The development seed itself is unchanged (not in this
   track's files): `pnpm dev:all -- --seed` still has the problem. One exception per failed email,
   with no grouping, will also be noisy in real use.
6. **An accepted cancellation refunds nothing by itself.** The customer accepts "a refund of
   80.00" and `EnrollmentsService.cancel` raises `enrollment.cancellation_consequence_pending`
   for finance (DEC-009, by design). When finance then issues the refund with `POST
/v1/payments/{id}/refunds`, nothing links the two: the exception stays open until someone
   closes it by hand.
7. **`PeopleService.personNames` with no ids is a database error.** The HTTP query requires at
   least one id; an in-process caller with an empty list gets `syntax error at or near ")"` from
   `where id in ()` instead of an empty list (`identity/services/people.service.ts`).
8. **`pnpm demo` ran no worker.** The launcher started `dist/main.js`. Standings, notices and
   message sending are outbox follow-ups, so publishing a score in the demo changed nothing. It
   now starts `dist/dev-all.js`. Seen in the run: a published score moved the standings within
   two seconds and a confirmed message was sent by the periodic job within five minutes.
9. **The mobile demo had no organization.** `SPORTSPARK_ORGANIZATION_SLUG` was not set by the
   launcher, so Discover and the public views had nothing to start from. It is passed now.
10. **A team cannot be entered by its captain once the registration window has closed**, even
    for a season that is open; only staff can (`TeamEntriesService.create`). By design, but it
    means a late team is always a staff entry, which is how the dataset enters all of them.
11. **A roster player needs a date of birth as soon as the division has an age band**
    (`RosterService.addMember`: `date_of_birth_unknown`, with the fix named). Adults created at
    the desk without one cannot be rostered there. The demo divisions have no age band.
12. **Development sign-in is limited to ten a minute per address** (`dev_tokens`). A presenter
    will not notice; a script that signs in per request is answered 429.
13. **The fake payment provider's state lives in the process that used it.** The seed's "unknown"
    payment and "processing" refund are unknown to the API process's provider, so they stay as
    they are in the demo (which is what the demo wants); a staff "reconcile" was not tried.
14. **Known from Track C, seen again:** a class on the public schedule reads "Class" (catalog
    registers no public title).

## 5. Tours

Staff (`apps/staff/src/demo/roles.ts`), new or rewritten steps in bold:

- Front desk (10): Today; **arrival and waivers at the door**; **waivers on a person's record**;
  **assisted registration with tiers, add-ons, a jersey, the per-class and the member price**;
  **applications waiting**; **uniform list**; **rental group roster**; **register and open-amount
  lines**; People; Payment problems.
- League manager (9): Competitions; **a season under way**; Rule sets; **team waiting list and
  place offers**; Schedule drafts; **results and standings**; **public standings and the lobby
  display**; **messages for the season**; Disputes.
- Administrator (11): Accounts; **capability switches (the ten named)**; Programs; **price tiers,
  add-ons and a uniform**; **per-class and member prices**; **waitlist**; **message templates and
  sequences**; Messages; **open-amount lines on the register**; Reports; Audit.
- **General manager (7, new role):** Today; money that needs a decision; approve an open-amount
  line; applications to decide; fields and maintenance; closures; reports for the finance roles.
- Coach (3) and referee (2): unchanged screens, copy and "try this" for the seeded assignments.

Mobile (`apps/mobile/src/demo/tour.ts`, 13 steps): new are class prices explained, camp by the
week or by the day, accept a waiver, rental roster invitation, public schedule and standings. The
class and camp steps open Discover and name the offering, because an offering's route carries an
id and the mobile demo receives no links (its configuration is outside this track's files).

## 6. Verification

**Verified by tests** (PGlite):

- `apps/api/src/dev/__tests__/seed-demo.spec.ts`, 13 tests: a fresh database; a second run that
  changes no table and returns the same summary; the refusal outside development and without
  local identity; every capability on; and, through the modules' read services, a published class
  with a session today, a per-session rule with five classes left, a member price, tiers with
  add-ons and a uniform, the approved waiver with a paper acceptance and a missing one, populated
  standings, the waiting team with the open offer, the public reads without sign-in, the rental
  roster, the three open-amount lines with one approval, the message schedule; then, through the
  routes after signing in at `POST /v1/dev/tokens`, rows for every staff role and the seeded
  parent; and a run at 23:30 on a Sunday.
- The staff demo test (16) and the mobile demo test (9): every step and every link is a route,
  the new features are in the tours of the roles they belong to, the copy has no identifiers.
- `apps/api/src/dev` as a whole and `apps/api/src/__tests__/production-boot.spec.ts` (25 tests),
  and the static checks `cross-module-ports`, `declared-interfaces`, `staff-scopes` (10 tests).

**Verified by the real run** (`pnpm demo --fresh`, once the tests passed; the API on 3000 and the
dashboard on 5173; stopped afterwards):

- The seed ran against a file database with the real clock in about 35 seconds and reported
  nothing as not created. This is where finding 1 appeared: the tests cannot see it.
- Each of the six staff roles and the parent signed in through `POST /v1/dev/tokens` with the
  account id the role picker uses, and the main read of every tour step was requested: 88 reads,
  all 200, with rows where the tour says there are rows. Two reads are empty by design of the
  dataset: the front desk's own exception queue (the open exceptions are finance's, which the
  general manager sees) and the official's fee list (the tour step says it fills later).
- 24 checks of the tours' "try this" items through the API: publishing a waiting score and the
  standings following (worker); previewing and confirming a message, and the worker sending it;
  approving the applied team; withdrawing the place offer; a paper waiver; three desk quotes
  (member price, per class, camp single day with lunch and a jersey); a jersey handed over; the
  desk refused on its own open-amount line, the manager approving it, the desk taking payment;
  an application accepted; the coach and the official accepting an assignment; the parent
  accepting the child's waiver and the roster invitation.
- The dashboard's dev server answered and served the demo build with the links; the lobby page
  answered 200. No request in the run answered 5xx.

**Not verified:**

- No screen was looked at in a browser or on a phone, in either theme. The run checked the reads
  and commands behind the screens, not the screens. Whether each "try this" is one obvious action
  on its screen was not checked.
- `pnpm demo --mobile` was not started; the mobile tour is verified by its test only.
- PostgreSQL (`TEST_DATABASE_URL`): nothing here was run against it.
- The whole API suite was not run (by instruction).
- A demo database older than the day it was seeded (the dates do not move with it).
- A second `pnpm demo` without `--fresh` in the real launcher (the second run is tested in the
  spec, with the test clock).

## 7. To do at integration, and debt

- `VITE_DEMO_LINKS` is read in `apps/staff/src/demo/links.ts`; nothing outside `src/demo` changed.
- The names of the tour links are held in three places that must agree: `seed-demo.ts`
  (`tourLinks`, `publicLinks`), the API spec (the key lists) and `links.ts` (`DEMO_LINK_NAMES`,
  with the sample shapes in the staff test). A shared constant would need a contracts export.
- The dataset must be kept working as commands change (ADR-007's stated cost). The spec is the
  alarm; the real-clock path (finding 1) is only covered by running `pnpm demo`.
- The mobile app cannot open a seeded record from its tour (no links); passing them needs a field
  in `apps/mobile/app.config.ts`.
- The general manager account (`demo-manager`) exists only in the demo dataset. If the role
  should also exist for `seed:dev`, it belongs in `seed-dev.ts`.
- Findings 1, 2, 5, 6 and 7 are for the owners of catalog, enrollment, communications and
  identity.
