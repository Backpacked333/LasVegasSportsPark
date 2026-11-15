# DBA: schema changes for the ten amendments

Feature: `glass-demo-amendments`. Every file is a new migration; no applied migration was edited.

| File                                             | Module         | What                                                                                                    |
| ------------------------------------------------ | -------------- | ------------------------------------------------------------------------------------------------------- |
| `0020_core_amendment_capabilities.sql`           | core           | Ten capability ids in the capability and applicability checks                                           |
| `0211_catalog_price_rule_basis_and_member_price` | catalog        | `pricing_basis`, member price with its entitlement (both or neither, composite key)                     |
| `0215` to `0217`                                 | catalog        | Price rule tiers, offering add-ons, offering uniforms                                                   |
| `0220_catalog_waivers.sql`                       | catalog        | Policy kind `waiver`; acknowledgment `method` and paper date; required waivers; overrides (append-only) |
| `0305_scheduling_facility_public_views.sql`      | scheduling     | One public schedule view and code per facility                                                          |
| `0467_competition_team_waiting.sql`              | competition    | Entry state `waiting`, place offers, capacity trigger replaced                                          |
| `0470_competition_public_visibility.sql`         | competition    | Public flag and codes for competitions and seasons                                                      |
| `0521` to `0523`                                 | enrollment     | Tier and day selection, basket line add-ons and uniforms, uniform orders                                |
| `0530_enrollment_booking_rosters.sql`            | enrollment     | Rental roster members and invitations                                                                   |
| `0687_finance_quote_line_price_basis.sql`        | finance        | `quote_lines.price_basis`                                                                               |
| `0690`, `0691`                                   | finance        | Quote and order line kinds and sources; quote line uniqueness widened                                   |
| `0695`, `0696`                                   | finance        | Open-amount register lines (line shape check), line approvals (append-only)                             |
| `1013_communications_message_sequences.sql`      | communications | Templates, sequences, steps, scheduled messages with a transition guard                                 |
| `1310`                                           | reporting      | Two read-only views over open-amount lines and their returns                                            |

## Rules kept

- Every new table carries `organization_id` and references other org-scoped tables by composite
  key. Ids are application-generated. Money is minor units with a currency.
- Lifecycles (`waiting` entries, place offers, uniform orders, scheduled messages, roster
  members and invitations) list the same states in the database check as in the state machine.
- Append-only: waiver overrides, hand-over events, line approvals.
- Each track has tests that write the violating row directly and expect the database to refuse.

## Replaced objects (each by a new migration that restates every earlier rule)

- `team_entries_check_division_capacity` (0400): now counts applied, approved and open place
  offers, never waiting entries.
- `pos_sale_lines_apply` and the line shape (0607 to 0686): a line is a product line or an
  open-amount line.
- The capacity pool unique constraint (0500): a unique index that includes the session scope.
- `quote_lines` uniqueness on `(quote_id, basket_line_id)`: one place line plus one line per
  add-on or uniform.

These four are the subject of the security review's database section: a replacement must not
drop a rule the original enforced.

## Known imprecision

- `reporting_team_entries_v.division_id` is typed as never null while a waiting entry has no
  division. The two reports read approved entries only. Present before this work for entries
  without a division.
- `quote_lines.source_id` is guarded by a trigger rather than a foreign key, because it names an
  add-on or a uniform depending on the line kind.

## Added by the review fixes

| File                                                 | What                                                                      |
| ---------------------------------------------------- | ------------------------------------------------------------------------- |
| `0221_catalog_waiver_override_version.sql`           | An override names the waiver version it was recorded against              |
| `0471_competition_public_adult_divisions.sql`        | A publication requires an adult minimum age on every division             |
| `0524_enrollment_waitlist_selection.sql`             | A waitlist entry records the tier, days, add-ons and uniform it waits for |
| `0525_enrollment_allocation_once_per_enrollment.sql` | One active allocation per enrollment per pool (unique index)              |
| `0531_enrollment_booking_roster_acceptance.sql`      | Who a roster acceptance joined and who acted                              |
| `0697_finance_pos_open_amount_sale_total.sql`        | The ceiling applies to what one person entered on one sale                |

`0525` can refuse on existing data: it fails if a database already holds two active allocations
for one enrollment in one pool.
