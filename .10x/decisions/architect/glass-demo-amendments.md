# Architecture: glass-demo-amendments

Decision records: ADR-001 to ADR-007. This file is the technical contract each track builds from.
Everything follows `CLAUDE.md` (command pattern, data rules, module ownership, tests).

## 0. Shared foundation (lands before any track)

- `main` merged into the branch; shell conflicts resolved keeping the drawer, focus and support
  link behaviour of pull request 22 inside the glass shell.
- Ten capability ids, `enforcement: 'commands'`: `liability_waivers` (DEC-095),
  `per_session_pricing` (DEC-096), `price_tiers_addons` (DEC-097), `member_pricing` (DEC-098),
  `message_sequences` (DEC-099), `public_schedule` (DEC-100), `uniforms` (DEC-101),
  `open_amount_lines` (DEC-102), `rental_rosters` (DEC-103), `team_waitlist` (DEC-104).
  Files: `packages/contracts/src/capabilities.ts`, core migration `0020`,
  `packages/api-client/src/capabilities.ts`.
- Generated files are regenerated at integration, never merged by hand:
  `docs/api/openapi.json`, `packages/api-client/src/generated/paths.ts`,
  `docs/package-a/permission-matrix.generated.md`, `packages/db/src/schema/index.ts`,
  `packages/contracts/src/api/index.ts` (`node scripts/regenerate-registrations.mjs`).

Migration numbers reserved per track (a new file must sort after everything it depends on):

| Track | catalog   | enrollment | finance   | competition | scheduling | entry | communications | reporting |
| ----- | --------- | ---------- | --------- | ----------- | ---------- | ----- | -------------- | --------- |
| A     | 0211-0214 |            | 0687-0689 |             |            |       |                |           |
| B     | 0220-0229 | 0530-0539  |           |             |            | 0881  |                |           |
| C     |           |            |           | 0467-0479   | 0305-0309  |       |                |           |
| D     | 0215-0219 | 0521-0529  | 0690-0694 |             |            |       |                |           |
| E     |           |            |           |             |            |       | 1013-1019      |           |
| F     |           |            | 0695-0699 |             |            |       |                | 1310      |

## 1. Tracks

### Track A: per-session price and member price (PA-02, PA-04)

- `price_rules`: `pricing_basis text not null default 'term'` (`term`, `per_session`);
  `member_price_minor bigint`, `member_entitlement_definition_id uuid` (both or neither; composite
  foreign key with `organization_id`).
- `quote_lines.price_basis jsonb` and the same on order lines where absent.
- Quote: for `per_session`, count the offering's sessions with status `scheduled` and start after
  the quote instant (read outside the transaction), unit price = per-session price × count; a
  count of zero refuses the line with a reason. Member price applies when the participant (after
  merge resolution) holds the named membership at the quote instant, read through a new
  enrollment port (`MEMBERSHIP_PRICING_PORT`).
- With a switch off the rule fields are refused on write and ignored on read of old rows.
- Contracts: `CreatePriceRuleBody`, `PriceRuleSchema`, `PublicPriceSchema`, `QuoteLineSchema`.
- Staff: price section of `OfferingSetupScreen`; quote display in assisted registration.
  Mobile: `QuoteReviewScreen`, `OfferingDetailScreen` ("24.00 per class × 7 classes = 168.00";
  "Member price applied: ...").
- Tests: `facility-class.spec.ts` keeps the gap with the switch off and gains the per-session
  quote with it on; database tests for the both-or-neither check and the foreign key.

### Track B: waivers and rental rosters (PA-01, then PA-09)

PA-01:

- Policy kind `waiver` (widen the kind check); content schema with `renewal` and `enforcement`.
- `acknowledgments`: `method` (`digital`, `paper`), `paper_dated_on date`; check: paper implies
  recorded by staff and a paper date; digital implies no paper date.
- `offering_required_waivers (organization_id, offering_id, policy_key)`.
- `waiver_overrides` (append-only): person, policy key, activity reference, reason, staff actor.
- Port: `waiverStatus(organizationId, personId, policyKey, at)` returning `current`, `lapsed` or
  `missing` with accepted version, accepted time, method and the rule applied.
- Reads and commands: `GET /people/:id/waivers` (staff; the person; a guardian with
  `complete_forms`), `POST /waiver-acceptances` (digital by self or guardian; paper by staff naming
  the signer and the paper date), `POST /waiver-overrides`.
- Callers: registration evaluation (`waiver_missing`, `waiver_lapsed`: warning or blocking by the
  policy), arrival checks (same), roster readiness.
- Staff: person record waiver panel, arrival `WaiverActions`, offering form ("requires waiver").
  Mobile: account Forms screen, registration required forms.

PA-09:

- `booking_roster_members` (booking, person or invited contact, status `invited`, `joined`,
  `removed`, added by) and `booking_roster_invitations` (token hash, expiry, accept, decline,
  revoke), modelled on team invitations; unique live member per booking and person.
- `GET/POST /bookings/:id/roster`, `POST /bookings/:id/roster/invitations`,
  `POST /booking-roster-invitations/:id/accept|decline|revoke`, remove a member. The roster read
  carries each member's waiver status for the offering's waiver key, or `not_evaluated` when
  `liability_waivers` is off.
- Being on a roster grants nothing: no competition record, no enrollment, no report row.
- Staff: roster panel in `BookingDetail`. Mobile: roster and invite in `BookingDetailScreen`, an
  accept screen for the invited person.

### Track C: team waiting list and public views (PA-10, PA-06)

PA-10: ADR-006. `team_entries.status` gains `waiting`, `waiting_since`; capacity trigger counts
`applied`, `approved` and open offers; `team_entry_place_offers`; commands `wait` (staff, or
automatic on create or placement into a full division when the switch is on), `offer`, `accept`,
`decline`, `withdraw`; expiry by an outbox event due at the expiry time. Reads: waiting list per
division and season with order; the captain's workspace shows position and any open offer.
Staff: `TeamEntryReviewScreen`, a waiting list panel on the teams screen. Mobile: team entry and
workspace screens. `facility-league.spec.ts` gains the waiting path with the switch on.

PA-06: ADR-005. `competitions.public_visibility` and `public_code`; `seasons.public_code`;
`facilities` public schedule code (owned by scheduling as `facility_public_views`). Commands to
publish and unpublish a competition and to enable a facility's public schedule. Public reads under
`/v1/public/...` with dedicated schemas and the `public_views` rate limit. Staff web routes
outside the session guard: `/lobby/:organization/:code` (self-advancing, keeps the last answer,
shows when it was fetched) and `/public/:organization/...` pages for schedule, fixtures, results,
standings and bracket. Mobile: signed-out Discover links to today's schedule and public standings.

### Track D: camp tiers, add-ons and uniforms (PA-03, PA-07), after Track A

ADR-003. `price_rule_tiers`; `offering_addons`; `basket_line_addons`; day selection on basket
lines and enrollments (`selected_session_ids`); `offering_uniforms`, `basket_line_uniforms`,
`uniform_orders` (ordered, paid, handed over; hand-over is a command with actor and time);
`quote_lines.line_kind`, `source_id` and the wider uniqueness; add-on capacity through
`capacity_pools` with scope `addon`. Attendance for a session lists only participants whose
selection includes it and shows their add-ons for the day. Staff: offering setup (tiers, add-ons,
uniform), assisted registration, a uniform list per team or class with hand-over. Mobile: add-on
and uniform choices in the registration flow, their lines on quote and receipt.

### Track E: message templates and sequences (PA-05)

`message_templates`, `message_sequences`, `message_sequence_steps`, `scheduled_messages`
(status `needs_confirmation`, `confirmed`, `skipped`, `sent`, `canceled`; an edited copy of title
and body; the notification it produced). Handlers on `competition.season_created` and
`catalog.offering_published` materialize a schedule from the matching sequence (registered in the
event handler manifest). A periodic job sends confirmed messages that are due through the existing
compose and queue path, so recipients and preferences are resolved at send time (SPK-COMMS-006,
SPK-COMMS-007). Staff: templates and sequences under Communications; a season's or offering's
message schedule with preview (real details filled in, recipients preview), edit, skip, confirm,
and what was sent.

### Track F: open-amount register line (PA-08)

`pos_line_categories` (code, name, ledger account, charge treatment, proposed and approved by
different people); `pos_sale_lines`: `product_id` nullable, `category_id`, `description`,
`line_kind` gains `open_amount`, amount positive, product or category but not both;
`pos_line_approvals` for a line above the actor's ceiling (requested by, approved by a different
permitted person, before the sale can take a tender). The ceiling per role is a value of the
approved finance policy. Returns use the existing workflow. Revenue journaling and the reporting
view group by category. `facility-register.spec.ts` gains the open-amount sale with the switch on.

### Track G: demo mode and dataset (last wave)

ADR-007. Port of the demo commit onto the new shell and sign-in; `apps/api/src/dev/seed-demo.ts`;
tours extended for the ten amendments; `pnpm demo`.

### Track H: glass-forward interface (runs throughout, owner of shared styles)

ADR-001. Owner of `apps/staff/src/ui/**`, `apps/staff/src/layout/**`, `apps/staff/src/theme/**`,
`apps/mobile/src/ui/**`, `apps/mobile/src/navigation/**`. Other tracks use the shared primitives
and tokens and do not edit these directories.

## 2. Failure modes designed for

- A switch turned off mid-flow: the command answers ACCESS_DENIED with `CAPABILITY_DISABLED`;
  both clients already render that as "turned off".
- A provider is never called in a transaction; sequences send through the existing delivery path.
- Public reads fail closed: unknown organization, code or switch off all answer "not available".
- Offer expiry and scheduled sends are idempotent under replay (handlers keyed by the record).
