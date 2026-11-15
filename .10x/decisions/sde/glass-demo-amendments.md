# SDE: glass, demo mode and the ten amendments (what was built)

Feature: `glass-demo-amendments` · Branch: `claude/jolly-johnson-gd61vv`

Each track has its own note with files, deviations, debt and what was not verified.

| Track | Amendments   | Requirement ids             | Capabilities                            | Note         |
| ----- | ------------ | --------------------------- | --------------------------------------- | ------------ |
| A     | PA-02, PA-04 | SPK-PAY-013, SPK-PAY-015    | `per_session_pricing`, `member_pricing` | `track-a.md` |
| B     | PA-01, PA-09 | SPK-REG-011, SPK-COND-005   | `liability_waivers`, `rental_rosters`   | `track-b.md` |
| C     | PA-10, PA-06 | SPK-COMP-006, SPK-SCHED-010 | `team_waitlist`, `public_schedule`      | `track-c.md` |
| D     | PA-03, PA-07 | SPK-PAY-014, SPK-REG-012    | `price_tiers_addons`, `uniforms`        | `track-d.md` |
| E     | PA-05        | SPK-COMMS-009               | `message_sequences`                     | `track-e.md` |
| F     | PA-08        | SPK-PAY-016                 | `open_amount_lines`                     | `track-f.md` |
| G     | demo mode    | SPK-UX-005, SPK-UX-007      | all, in the demo database only          | `track-g.md` |
| H     | interface    | SPK-UX-009, SPK-UX-010      | none                                    | `track-h.md` |

## Integration (done after each track reported)

- Tracks were built in separate worktrees from the capability commit and merged one at a time.
  After each merge: registrations regenerated, API description, client types and permission
  matrix rebuilt, full typecheck, then the suites the merge could affect.
- Added at integration: the uniform list route; the catalog title contributor for the public
  schedule; `waiting` in the reporting view type; page toolbars of the two team screens on glass.
- Mistake made and corrected at integration: a conflict in `packages/db/src/schema/reporting.ts`
  was resolved by taking one whole side, which dropped track F's two report views; the build
  caught it and F's file was restored.

## Deviations that change behaviour (decided by tracks, kept)

- A per-session rule, a tier, an add-on or a uniform on a line is refused at quote when its
  capability is off, instead of being priced as a plain line (A, D).
- Cancellation and transfer of a place with a stored price basis use the quoted price; a transfer
  involving tiers or extras answers `review_required` (A, D).
- Required waivers are their own resource on an offering; a waiver version cannot be accepted
  through the general acknowledgment route (B).
- A public directory read lists an organization's public schedules and competitions (C). Under
  security review.
- A confirmed message stores the exact text that will be sent, and returns to needing
  confirmation when its date or text would change (E).
- An open-amount approval is its own append-only record; categories and ceilings are policy
  content under an existing policy kind (F). A dedicated kind is a pending architect decision.

## Technical debt carried

See each track note. The items most likely to matter first: lines opened outside a basket name no
tier (`TIER_REQUIRED`); arrival checks do not read a camp participant's chosen days; contact
invitations to a rental roster are not matched to a verified contact; nothing notifies an approver
or a captain (open-amount approval, place offer); message audiences above the notice limits are not
split.

## Intermittent tests found while integrating

- Fixed (root cause: a control pressed or an option read before the second read it depends on):
  the glass browser smoke test, two rental roster screen tests.
- Not root-caused: `apps/mobile/src/screens/teams/__tests__/ContributionScreen.test.tsx`
  ("Check again" leaves "Payment processing"), present on `main`. Seen once in CI and once in a
  local full run; never when its file runs alone, including under load.
