# Team screens (SCR-C-21 to SCR-C-29)

Customer app screens for teams and captains (spec §2.2, §3.4, §3.5, §3.11, §3.15; journeys A and B
in `docs/package-a/journeys.md`; rows SCR-C-21 to SCR-C-29 in
`docs/package-a/screen-and-journey-inventory.md`).

Status legend (§6.7): **Verified** = implemented and asserted by a jest test here, against a mocked
API. **Proposed** = engineering proposal awaiting approval. **Pending decision** = waits on an
operator answer (owners in `docs/package-a/decision-register.md`). Nothing here has passed native
acceptance on signed builds and devices (§6.2), including VoiceOver, TalkBack and large text.

## Routes

| Route (`app/`)                             | Screen                                 | Inventory |
| ------------------------------------------ | -------------------------------------- | --------- |
| `(tabs)/teams`                             | `TeamsScreen`                          | SCR-C-21  |
| `team/[entryId]`                           | `TeamWorkspaceScreen`                  | SCR-C-22  |
| `team/[entryId]/roster`                    | `RosterScreen`                         | SCR-C-23  |
| `team/[entryId]/availability`              | `AvailabilityScreen`                   | SCR-C-24  |
| `team/[entryId]/contributions`             | `TeamContributionsScreen` (team view)  | SCR-C-25  |
| `team/contribution/[requestId]`            | `ContributionScreen` (a player's line) | SCR-C-25  |
| `team/[entryId]/roster-change`             | `RosterChangeScreen`                   | SCR-C-26  |
| `team/new`, `team/new?renewFrom=<entryId>` | `TeamEntryScreen`                      | SCR-C-27  |
| `team/[entryId]/standings`                 | `StandingsScreen`                      | SCR-C-28  |
| `team/[entryId]/results/[fixtureId]`       | `FixtureResultsScreen`                 | SCR-C-28  |
| `team/[entryId]/disputes/[fixtureId]`      | `DisputeScreen`                        | SCR-C-29  |

Route parameters are record ids only, validated as UUIDs (`features/teams/routes.ts`); anything
else is "not available" and sends no request (§4.14). Shared pieces live in `src/features/teams/`.

## What is implemented and how it is verified

| Behaviour                                                                                                                                                                                                                               | Status                                                                    | Evidence                                                 |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------- |
| Captain workspace: upcoming games, standing, readiness indicators with who resolves each issue; approval, payment, roster completion and eligibility kept distinct (SPK-CAP-001, SPK-CAP-002, SPK-COMP-004).                            | **Verified**                                                              | `__tests__/TeamWorkspaceScreen.test.tsx`                 |
| Reduced player view: no captain sections, teammates without eligibility indicators (SPK-CAP-002).                                                                                                                                       | **Verified**                                                              | same                                                     |
| Roster with effective dates, pending rows and history (SPK-COMP-005); invitations per recipient, each its own idempotency key and outcome (partial completion); link shared once through the native share sheet; revoke; join requests. | **Verified**                                                              | `__tests__/RosterScreen.test.tsx`                        |
| Availability counts per game, the person's own answer, answering for a child with `register`; never attendance or eligibility; a missing answer never blocks (SPK-CAP-003, SPK-READY-002).                                              | **Verified**                                                              | `__tests__/AvailabilityScreen.test.tsx`                  |
| Team totals (total, received, allocated, remaining) together; excess kept visible; contributions with amount and status only; captain requests in minor units (SPK-PAY-004, SPK-PAY-005, SPK-AT-022).                                   | **Verified**                                                              | `__tests__/TeamContributionsScreen.test.tsx`             |
| A player's own contribution and payment; processing and unknown outcomes never offer paying again (SPK-PAY-007).                                                                                                                        | **Verified** in development builds (fake provider)                        | `__tests__/ContributionScreen.test.tsx`                  |
| Roster change and substitute: eligibility explained by the API, a suspended substitute refused with its reasons (SPK-AT-013), league approval shown as pending, `expectedRevision` sent, stale roster reloaded.                         | **Verified**                                                              | `__tests__/RosterChangeScreen.test.tsx`                  |
| Create or renew a team entry: renewal leaves the prior season untouched, charges nothing, suggested players invited, not added (SPK-CAP-005, SPK-AT-003).                                                                               | **Verified** client side; the prior-season invariant is the API's         | `__tests__/TeamEntryScreen.test.tsx`                     |
| Official standings with rule set version and tiebreak explanations; results "Official", "Corrected on <date>", replaced results kept; published bracket (SPK-RESULT-001 to 004).                                                        | **Verified**                                                              | `__tests__/StandingsScreen.test.tsx`                     |
| Dispute within the rule set's window, with reason and evidence; closed window shown with the draft kept (SPK-RESULT-005).                                                                                                               | **Verified**                                                              | `__tests__/DisputeScreen.test.tsx`                       |
| Every `app/team/*` route resolves through the real router; a malformed id is not available.                                                                                                                                             | **Verified**                                                              | `__tests__/team-routes.test.tsx`                         |
| Which sections a screen shows follows the API's role records for the signed-in person; the API authorizes every command and a refusal is "not available".                                                                               | **Proposed** (the workspace states no permitted actions)                  | `features/teams/queries.ts`, `features/teams/__tests__/` |
| Teams listed on SCR-C-21 are the ones opened or created in this app session, in memory only.                                                                                                                                            | **Proposed** stopgap: the API has no list of a person's teams             | `features/teams/opened-teams.ts`                         |
| "Tentative" availability.                                                                                                                                                                                                               | **Pending decision** DEC-064 (Product and operations): not offered        | `AvailabilityScreen.tsx`                                 |
| Invitation expiry.                                                                                                                                                                                                                      | **Pending decision** POL-044: the server's expiry is shown, none is sent  | `RosterScreen.tsx`                                       |
| Overpayment handling.                                                                                                                                                                                                                   | **Pending decision** DEC-008, POL-015: excess shown, no handling promised | `features/teams/ObligationTotals.tsx`                    |
| Paying a contribution in a release build.                                                                                                                                                                                               | **Pending decision** DEC-019 (Technical lead/account owners)              | `features/teams/dev/`                                    |
| Appeals of dispute decisions.                                                                                                                                                                                                           | **Pending decision** DEC-010 (League manager/operator)                    | `DisputeScreen.tsx`                                      |
| What captains may see beyond the API's indicators; public sharing of standings.                                                                                                                                                         | **Pending decision** DEC-012 (Operator/privacy owner): not offered        |                                                          |

## Not available from the API (rendered as "not available")

- A list of the teams the person and their children belong to (SCR-C-21 needs `GET /v1/me/team-entries` or similar).
- Contacting the operating team: `POST /v1/cases` is staff only (SCR-C-22, SPK-CAP-001).
- A captain's availability request or reminder to the roster (SCR-C-24).
- The current availability answer of a child a guardian answers for (only the acting person's is returned).
- A player's list of the contribution requests addressed to them (SCR-C-25).
- A forms-outstanding readiness indicator in the workspace (SCR-C-22).
- Recording a substitute or guest request for league approval when the rule set requires it (SCR-C-26).
- A customer's preferred division on a team entry (SCR-C-27; only staff may place an entry).
- Facility time zones for fixtures: times are shown in the device's zone with the zone named.
