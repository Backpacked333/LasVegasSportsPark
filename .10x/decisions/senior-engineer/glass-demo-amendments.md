# Senior engineer: glass-demo-amendments

Approach per track (files to start from; the architect file has the contract):

- **Foundation.** `packages/contracts/src/capabilities.ts`; `packages/db/migrations/0020_core_amendment_capabilities.sql`
  (drop and recreate both checks of `organization_capabilities`); `packages/api-client/src/capabilities.ts`;
  `apps/api/src/kernel/__tests__/capabilities.spec.ts` expects exactly the catalogue.
- **A.** `catalog/services/price-rules.service.ts`, `catalog/pricing/pricing.service.ts`,
  `finance/services/quotes.service.ts` (pricing happens before the unit of work, where sessions
  may be read), `finance/pricing/quote-calculator.ts`, `enrollment/services/membership-ledger.ts`
  (export a port). Tricky: the `base = unit × quantity` check; keep quantity as the basket
  quantity and put the multiplication into the unit price with the basis stored.
- **B.** `catalog/services/acknowledgments.service.ts` and `policies.service.ts` (keep every
  signing rule), `catalog/catalog.ports.ts`, `enrollment/eligibility/registration-eligibility.ts`,
  `entry/services/arrival-checks.ts`, `enrollment/services/bookings.service.ts`. Tricky:
  acknowledgments are immutable; new columns need defaults that satisfy the new checks for old
  rows.
- **C.** `competition/competition.state-machines.ts`, `competition/services/team-entries.service.ts`,
  migration replacing the capacity trigger; new `competition/public/` and `scheduling/public/`
  controllers with their own queries. Tricky: the capacity race (test under PostgreSQL);
  anonymous requests have no organization, resolve it from the slug as the public offering list
  does.
- **D.** `enrollment/services/baskets.service.ts`, quotes and checkout finalizer for extra lines,
  `enrollment/services/capacity.service.ts` for add-on capacity. Tricky: replacing a unique
  constraint on append-only `quote_lines`; attendance filtered by day selection.
- **E.** New files under `communications/`; handlers registered in `onModuleInit` and in
  `apps/api/src/__tests__/event-handler-manifest.json`; a job modelled on `activity-reminders.ts`.
  Tricky: recipients are resolved when a notice is queued, so queue only when due.
- **F.** `finance/services/pos/pos-sales.service.ts`, `pos-sale-finalizer.service.ts` (revenue by
  category), triggers of `pos_sale_lines` (0607, 0610, 0615, 0616, 0686) when `product_id`
  becomes nullable. Tricky: returns and the quantity triggers for a line without a product.
- **G.** Port `scripts/demo.mjs`, `apps/staff/src/demo/**`, `apps/mobile/src/demo/**` from commit
  76a4cce8; resolve its four conflicts against the new shell and sign-in by hand.
- **H.** Staff: backdrop at the application root, `Glass` for stat tiles and page toolbars with a
  cap on bodies in view; mobile: `GlassSurface` in `apps/mobile/src/ui`.
