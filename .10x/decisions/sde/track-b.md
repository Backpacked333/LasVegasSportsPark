# Track B hand-off: liability waivers (PA-01) and rental-group rosters (PA-09)

Status words follow §6.7. Both amendments stay **Proposed**; their open values stay **Pending
decision** (DEC-095, DEC-103). What the code does with a capability on is **Verified** by the
tests named.

## 1. What was built

### PA-01, SPK-REG-011, capability `liability_waivers`

Design as decided in ADR-004.

| Layer        | Files                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Migration    | `packages/db/migrations/0220_catalog_waivers.sql`                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Schema types | `packages/db/src/schema/catalog.ts` (kind, `method`, `paper_dated_on`), `catalog-waivers.ts` (new)                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Contracts    | `packages/contracts/src/api/catalog.ts` (kind `waiver`, `WaiverContentSchema`, acknowledgment `method` and `paperDatedOn`), `catalog-waivers.ts` (new), `entry.ts` (two arrival issue codes)                                                                                                                                                                                                                                                                                                                                |
| Catalog      | `waivers/waiver-rule.ts` (the one judgement, pure), `services/waiver-status.reader.ts`, `services/waivers.service.ts`, `controllers/waivers.controller.ts`, `services/acknowledgments.service.ts` (the one signing path, now with a method), `services/policies.service.ts` (port methods, capability on drafting a waiver), `services/offerings.service.ts` (snapshot field, copy), `catalog.ports.ts`, `catalog.actions.ts`, `catalog.events.ts`, `catalog.policy.ts`, `catalog.shared.ts`, `testing/catalog-fixtures.ts` |
| Callers      | `enrollment/eligibility/registration-eligibility.ts`, `enrollment/services/registration-evaluator.ts`, `enrollment/services/competition-forms-check.ts`, `entry/services/arrival-checks.ts`, `entry/services/activity-resolver.ts`                                                                                                                                                                                                                                                                                          |
| Competition  | `competition-matches.ports.ts` (optional `severity` on `ConditionFinding`), `services/readiness.service.ts` (one line that honours it). Nothing else.                                                                                                                                                                                                                                                                                                                                                                       |
| Staff        | `features/waivers/` (new), `screens/people/WaiversCard.tsx` (new) in `PersonRecordScreen.tsx`, `screens/arrival/WaiverActions.tsx`, `screens/programs/OfferingForm.tsx` (`RequiredWaivers`) in `OfferingSetupScreen.tsx`                                                                                                                                                                                                                                                                                                    |
| Mobile       | `src/features/waivers/` (new), `src/screens/account/FormsScreen.tsx`, `src/screens/registration/RequiredFormsScreen.tsx`                                                                                                                                                                                                                                                                                                                                                                                                    |

Routes: `GET /people/{id}/waivers`, `POST /waiver-acceptances`, `POST /waiver-overrides`,
`GET` and `POST /offerings/{id}/required-waivers`. Port: `PolicyPort.waiverStatus`,
`waiverStatuses`, `waiverFindings`; `OfferingSnapshot.requiredWaiverKeys`.

### PA-09, SPK-COND-005, capability `rental_rosters`

| Layer        | Files                                                                                                                                                                                                                                               |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Migration    | `packages/db/migrations/0530_enrollment_booking_rosters.sql`                                                                                                                                                                                        |
| Schema types | `packages/db/src/schema/enrollment-rosters.ts` (new)                                                                                                                                                                                                |
| Contracts    | `packages/contracts/src/api/enrollment-rosters.ts` (new)                                                                                                                                                                                            |
| Enrollment   | `services/booking-rosters.service.ts`, `controllers/booking-rosters.controller.ts`, `enrollment.state-machines.ts` (two machines), `enrollment.events.ts`, `enrollment.actions.ts`, `enrollment.module.ts`                                          |
| Staff        | `screens/package-g/bookings/BookingRoster.tsx` (new) in `BookingDetail.tsx`                                                                                                                                                                         |
| Mobile       | `src/screens/bookings/BookingRosterSection.tsx` (new) in `BookingDetailScreen.tsx`, `src/screens/bookings/RosterInvitationScreen.tsx` (new), `MyBookingsScreen.tsx` (a link), route files `app/booking-roster-invitations/index.tsx` and `[id].tsx` |

Routes: `GET` and `POST /bookings/{id}/roster`, `POST /bookings/{id}/roster/invitations`,
`POST /bookings/{id}/roster/members/{memberId}/remove`, `GET /me/booking-roster-invitations`,
`GET /booking-roster-invitations/{id}`, `POST /booking-roster-invitations/{id}/accept`, `decline`,
`revoke`.

Module READMEs updated: catalog, enrollment, entry, competition (one paragraph),
`apps/staff/src/features/waivers/README.md` (new), `apps/staff/src/screens/package-g/README.md`,
`apps/mobile/src/screens/account/README.md`, `apps/mobile/src/screens/registration/README.md`,
`apps/mobile/src/features/package-g/README.md`.

## 2. Deviations from the architect contract, and why

1. **The branch base.** The worktree was created at `main` (51253046), which has neither `.10x/`
   nor the ten capability ids. The branch was fast-forwarded to `claude/jolly-johnson-gd61vv`
   (95921687) before any work. Commits are listed against that base.
2. **Entry migration `0881` is not used.** Arrival issues are JSON on the check-in and no database
   check lists their codes, so there was nothing to migrate.
3. **Required waivers are their own resource** (`/offerings/{id}/required-waivers`), not fields of
   the offering create and update bodies. It keeps the `Offering` schema and the 1,800-line
   offerings service out of the change (Track A is in the same area) and makes the requirement one
   audited command. `OfferingSnapshot` carries the keys for the callers.
4. **A renewal of the same waiver version closes the lapsed acknowledgment as `withdrawn`** with a
   fixed reason, then records the new one. One active acknowledgment per person and version is an
   existing database rule (0200); the row is kept. A distinct `superseded` status would be clearer.
5. **`POST /acknowledgments` refuses a waiver version** (`USE_WAIVER_ACCEPTANCE`), so a waiver
   acceptance always carries its method and always checks the capability.
6. **A paper acceptance's `signed_at` is the server time of the staff entry**; the date on the
   paper is `paper_dated_on`, and the renewal rule counts from it. The existing backdating rule
   (staff only, with evidence) is unchanged for forms and is not used for waivers.
7. **Additional read `GET /me/booking-roster-invitations`**, and **no token is needed when the
   signed-in person is the person the invitation names.** No messaging channel delivers tokens
   (DEC-012, DEC-062), so a token-only flow could not be completed by an invited person. A token is
   still required for an invitation to a contact.
8. **A contact invitation is not matched against a verified contact point** of whoever accepts
   (team invitations are). A roster grants nothing; recorded as debt.
9. **Roster readiness lives in enrollment** (`competition-forms-check.ts` is competition's
   FORMS_CHECK_IMPL), so the only competition change is the optional `severity` on a finding.
10. **A rental's booker is the participant of the booking's registration**, so a required waiver
    whose rule blocks stops the booker at booking (PA-01). Roster members never block (PA-09).
    Under the assumed defaults (warn) neither blocks.

## 3. To do at integration

- **Generated files** were regenerated on this branch and must be regenerated again after the
  merge: `docs/api/openapi.json`, `packages/api-client/src/generated/paths.ts`,
  `docs/package-a/permission-matrix.generated.md`, `packages/db/src/schema/index.ts`,
  `packages/contracts/src/api/index.ts`.
- **Likely merge points with Track A** (different hunks): `packages/contracts/src/api/catalog.ts`,
  `packages/db/src/schema/catalog.ts`, `catalog/services/offerings.service.ts` (constructor gains
  `WaiversService`; `getOffering` and `copy` each gain one line),
  `apps/staff/src/screens/programs/OfferingSetupScreen.tsx` (one line),
  `apps/api/src/modules/catalog/README.md` (appended section).
- **Likely merge point with Track C**: `competition/services/readiness.service.ts` (one line in
  `addCondition`), `competition-matches.ports.ts`, competition `README.md` (appended paragraph).
- **Staff routes and navigation: none to register.** Every staff piece is a panel of an existing
  screen. **Mobile:** two route files under `app/booking-roster-invitations/`; expo-router serves
  them without registration (verified in the real navigator by
  `roster-invitation-routes.test.tsx`). No file under `apps/mobile/src/navigation` was touched; a
  quick-access destination for "Roster invitations" is optional and is the owner's call.
- **Event handlers: none added**, so `event-handler-manifest.json` is unchanged. New events with
  no subscriber: `catalog.waiver_override_recorded`, `catalog.offering_required_waivers_changed`,
  `enrollment.booking_roster_changed`, `enrollment.booking_roster_invitation_created`.
- **Demo dataset (Track G)** needs, through the services: an approved `waiver` policy version
  (content per `WaiverContentSchema`; the assumed defaults are `enforcement: 'warn'`,
  `reacceptOnNewVersion: false`, `renewEveryMonths: null`), required waivers on offerings
  (`WaiversService.setOfferingRequiredWaivers`), acceptances, and a roster on a rental booking
  (`BookingRostersService`). Both capabilities on.
- **Client capability presentation** for the two ids is in the files this track did not edit.

## 4. Technical debt created

- The `superseded` acknowledgment status (deviation 4).
- Roster invitations expire lazily; there is no periodic job, so an unanswered expired invitation
  leaves its row `invited` until removed.
- Contact invitations do not verify the contact (deviation 8).
- An override recorded against a scheduling event or a booking stores the id unverified (another
  module owns the record).
- Paper dates have no zone (bounds are "anywhere on earth"; renewal counts from midnight UTC).
- Legacy paper-waiver dates cannot be imported as paper acceptances by the migration principal:
  the database requires a named staff member.
- Staff screens show person references, not names, for the staff member who entered a paper
  waiver and for who recorded an override.
- No staff screen drafts or approves a waiver version; the policy version commands are used.
- The staff roster panel adds a person by reference (no person search inside the panel).
- The renter sees roster members' display names, children included (**Pending decision**).

## 5. Not verified

- Nothing was run against PostgreSQL (`TEST_DATABASE_URL`); every test ran on PGlite. The roster
  and waiver tests need no true concurrency, but the unique-index races are untested under it.
- The whole API suite was not run (by instruction); see the report for the exact runs.
- No screen was looked at in a browser or on a device; staff and mobile are verified by component
  tests only.
- The three gap journeys (`facility-class`, `facility-register`, `facility-league`) record no
  waiver or roster gap, so they were not changed.
