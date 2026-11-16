# SDE hand-off: Track A (PA-02 per-session price, PA-04 member price)

Feature `glass-demo-amendments`, wave 1. Status words follow §6.7. Both requirements
(SPK-PAY-013, SPK-PAY-015) are **Proposed**; their open values are **Pending decision** (DEC-096,
DEC-098). What is described as built is **Verified** by the tests named, on PGlite and on a local
PostgreSQL 16 where stated in section 6.

## 1. What was built

Catalog (price rules only):

- `packages/db/migrations/0211_catalog_price_rule_basis_and_member_price.sql`: `price_rules` gains
  `pricing_basis` (`term` default, `per_session`), `member_price_minor`,
  `member_entitlement_definition_id` (both or neither; composite foreign key with
  `organization_id`); `price_rules_guard` makes the three columns immutable. The exclusion
  constraint `price_rules_one_effective_per_instant` is untouched.
- `packages/db/src/schema/catalog.ts`, `packages/contracts/src/api/catalog.ts` (`PricingBasis`,
  `PriceRule`, `CreatePriceRuleRequest`, `PublicPrice`, `PublicMemberPrice`).
- `apps/api/src/modules/catalog/services/price-rules.service.ts` (capability checks inside the
  unit of work, entitlement validation, `remainingSessions`, `remainingSessionCounts`),
  `catalog.ports.ts` and `pricing/pricing.service.ts` (`PRICING_PORT.remainingSessions`),
  `catalog.shared.ts` and `services/offerings.service.ts` (the public price), fixtures, README.
- Tests: `apps/api/src/modules/catalog/__tests__/price-rule-amendments.spec.ts`.

Enrollment (the port only):

- `enrollment.ports.ts` (`MEMBERSHIP_PRICING_PORT`, `MembershipPricingPort`),
  `services/membership-pricing.ts` (the adapter), `services/membership-ledger.ts`
  (`holdsEntitlement`, sharing the query of `holds`), `enrollment.module.ts` (provider and export),
  README (one bullet). Test: `__tests__/membership-pricing.spec.ts`.

Finance (quotes):

- `packages/db/migrations/0687_finance_quote_line_price_basis.sql`: `quote_lines.price_basis jsonb`
  with two checks (the basis states the line's unit price; a basis needs a price rule).
- `packages/contracts/src/api/finance.ts` (`QuoteLinePriceBasis`, `MemberPriceReason`,
  `QuoteLine.priceBasis`), `packages/db/src/schema/finance.ts`.
- `apps/api/src/modules/finance/pricing/quote-calculator.ts` (`LinePricingFacts`, `priceBasisOf`,
  `unitPriceFromBasis`), `pricing/line-pricing.service.ts` (reads the two ports and the two
  switches, before the unit of work), `services/quotes.service.ts`,
  `services/finance-desk.service.ts` (the basket estimate follows the same pricing),
  `services/checkout.service.ts` (the order line's `price_basis.pricing`),
  `services/finance-policy.adapter.ts` (see deviation 5), `finance.shared.ts`, `finance.module.ts`,
  README.
- Tests: `pricing/quote-calculator.spec.ts`, `__tests__/quote-pricing-amendments.spec.ts`,
  `apps/api/src/__tests__/journeys/facility-class.spec.ts` (the gap with the capability off, the
  per-session journey with it on, and the refusal after it is turned off again).

Clients:

- Staff: `apps/staff/src/screens/programs/OfferingSetupScreen.tsx` (price section),
  `apps/staff/src/screens/registrations/AssistedRegistrationScreen.tsx` (quote lines),
  `apps/staff/src/features/registration-finance/price-basis.ts`, `pending.ts` (DEC-096, DEC-098),
  their tests and two fixture files.
- Mobile: `apps/mobile/src/screens/registration/QuoteReviewScreen.tsx`,
  `OfferingDetailScreen.tsx`, `apps/mobile/src/features/registration/price-basis.ts`, their tests,
  fixtures and the registration README. No style was added (existing `Body` and `Detail` only).

Generated: `docs/api/openapi.json`, `packages/api-client/src/generated/paths.ts`. The permission
matrix and the two registration index files came out unchanged.

## 2. Behaviour in one place

- Order of a unit price: member price, then per-session multiplication. `quantity` stays the
  basket quantity; `base = unit x quantity` and every existing check on `quote_lines` hold.
- A session counts when it is `scheduled` and starts strictly after the quote instant. A basket
  line that names one session counts that session only. None left: RESOURCE_CONFLICT
  `details.code = NO_SESSIONS_REMAINING`; no minimum charge.
- Member price: the participant, after merged-person resolution, holds a confirmed, unsuspended
  membership whose recorded entitlement is the rule's, at the quote instant. The basis records
  `active_membership`, `no_active_membership` or `membership_suspended` and the membership id.
- Capabilities off: the new price-rule fields are refused on write (CAPABILITY_DISABLED); a member
  price on an existing rule is not evaluated; a plain term line stores no basis (`priceBasis` null).

## 3. Deviations from the architect contract, and why

1. **Base commit.** This worktree had been created from `main` (51253046), which has neither the
   capability ids nor `.10x`. The branch was fast-forwarded to the wave 0 commit 95921687 (the tip
   of `claude/jolly-johnson-gd61vv`) before any work; there is no merge commit.
2. **A per-session rule while `per_session_pricing` is off is refused, not ignored.** The contract
   says the rule fields are "ignored on read of old rows". Ignoring `per_session` would charge the
   price of one session for the whole term. The quote answers ACCESS_DENIED `CAPABILITY_DISABLED`
   (the failure mode the same contract lists for a switch turned off mid-flow) and the basket
   estimate is `unpriced`. A member price is ignored as written. Rows written before the migration
   are all `term` without a member price, so nothing changes for them.
3. **Two port additions.** `PRICING_PORT.remainingSessions` (catalog) is new beside
   `MEMBERSHIP_PRICING_PORT` (enrollment): finance needs the session ids for the stored basis and
   may not read catalog tables.
4. **Extra response fields.** `PriceRule.memberEntitlementName`; `PublicPrice.remainingSessionCount`,
   `remainingSessionsPriceMinor` and `memberPrice`: the screens must show "24.00 per class x 7
   classes = 168.00" without computing a price. All new response fields are required, so typed
   fixtures elsewhere that build a `PublicPrice`, `PriceRule` or `QuoteLine` need them.
5. **Cancellation and transfer consequences (finance, outside "quotes").** Enrollment passes the
   rule's base price to `FinancePolicyPort`. For a place whose order line carries a price basis,
   the cancellation share is now worked out on the quoted unit price; a transfer out of such a
   place or into an offering priced that way answers `review_required`. Without this a 50% refund
   of a seven-session place would have been 50% of one session. Plain term places are unchanged.
6. **No order-line migration.** `order_lines.price_basis` already exists (0600, not null); the
   quote's basis is copied into it under the key `pricing`, only when present. Migrations used:
   0211 and 0687. 0212 to 0214 and 0688, 0689 are unused.
7. **Event payload unchanged.** `catalog.price_rule_created` keeps its payload (its field list is
   in the shared `docs/architecture/api-and-events.md`); the audit record carries the new fields.
8. **Commit messages carry no attribution trailer**, following `CLAUDE.md` ("no model names,
   session links").

## 4. To register at integration

- Routes, navigation, event handlers, actions: none added. No entry for the event handler manifest.
- Regenerate as usual (`pnpm build && pnpm openapi && pnpm api-client:generate && pnpm
permission-matrix`, `node scripts/regenerate-registrations.mjs`).
- Track D starts from: `LinePricingFacts` and `priceBasisOf` in
  `finance/pricing/quote-calculator.ts` (the tier goes before the member price),
  `QuoteLinePriceBasisSchema`, `LinePricing.factsFor`, and the checks of migration 0687 (a new
  line kind must keep `price_basis.unitPriceMinor` equal to its unit price, or store no basis).
- Track G (demo data): a per-session rule and a member price are created through
  `PriceRulesService.create` after the two capabilities are on; the membership entitlement must be
  an active `membership_benefit`.

## 5. Technical debt created or left

- **Enrollment's price snapshot** (`basket_lines.price_snapshot`, `enrollments.price_snapshot`,
  `PriceSnapshot.basePriceMinor`) still records the rule's base price. For a per-session rule that
  is the price of one session. It is shown before the quote on the customer basket ("Base price
  each") and in the staff basket line, and it is the `fromPrice` and `toPrice` of a transfer
  preview. Fixing it belongs to the enrollment module (registration evaluator), which this track
  was told not to change. Deviation 5 keeps the money consequences from using it wrongly.
- `apps/mobile/src/screens/discover/offering-look.ts` ("From $24.00") and the camp week list show
  `basePriceMinor` without saying "per class".
- The promotion badge (`catalog/pricing/promotions.ts`) compares a discount's minimum line amount
  with the rule's base price.
- No rule says a member price may not exceed the base price; none was invented.
- That the member entitlement is of kind `membership_benefit` is checked by the service, not by the
  database (the kind of a definition is not immutable).
- A session that starts between the quote and the checkout stays in the price; only the quote's
  validity (POL-013) bounds that. The cut-off is **Pending decision** DEC-096.
- A canceled or added session after purchase changes nothing by itself: the amendment leaves that
  to the approved refund and credit policy (DEC-009), which is not built here.
- Wording: customer and quote text says "per class" and "classes" (the phrase in the brief); the
  staff setup form says "each session", the word the setup screen already uses.

## 6. Verification and what could not be verified

See the track report for the command output. The four new specifications, the catalog schema
specification and the `facility-class` journey were also run against a local PostgreSQL 16
(`TEST_DATABASE_URL`), so migrations 0211 and 0687 are exercised on both drivers; the rest of the
runs used PGlite. Not verified:

- The catalog and finance suites as a whole under PostgreSQL (only the files above).

- The full API suite (about twenty minutes) was not run, by instruction; only the catalog and
  finance modules, the enrollment files touched, the journeys named in the brief and the static
  checks under `apps/api/src/__tests__`.
- No screen was looked at in a browser or on a device, in either theme; only the component tests.
- `pnpm verify` as a whole and the staff production build were not run.
