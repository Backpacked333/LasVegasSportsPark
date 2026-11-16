# Handoff

Feature `glass-demo-amendments` is complete on branch `claude/jolly-johnson-gd61vv` (draft pull
request 21).

## For the product owner

- **Try it**: `pnpm install && pnpm demo --fresh`, then open the address it prints and pick a role.
  The public standings, schedule and lobby links it prints need no sign-in. `--mobile` also starts
  the customer app (development build only).
- **Decide**: each of the ten features is a Proposed amendment behind its own switch, with its open
  values listed as Pending decision in the module READMEs (DEC-095 to DEC-104). Nothing is on in a
  real organization until it is turned on.
- **Check on phones** before release: the customer app was not run on a device.

## For whoever continues

- What was built, per track: `decisions/sde/track-a.md` to `track-h.md`; the whole in
  `decisions/sde/glass-demo-amendments.md`.
- Schema changes: `decisions/dba/glass-demo-amendments.md`.
- Reviews and their resolutions: `reviews/2026-11-14-qa-report.md`,
  `reviews/2026-11-14-security-review.md`; summaries in `decisions/qa` and `decisions/security`.
- Deploy and operations: `decisions/devops/glass-demo-amendments.md` (`TRUST_PROXY`, migration
  0525's check on existing data, rollback), `decisions/sre/glass-demo-amendments.md`.
- Known gaps worth a next piece of work: the transfer screens cannot pick a tier, days or uniform
  size (the API instruction is shown instead); no screen converts a trial; two desk users can each
  enter up to their ceiling on one sale; contact invitations to a rental roster are not matched to
  a verified contact; the staff queue across offerings (`GET /v1/waitlist-queue`) is still closed
  to the front desk.
