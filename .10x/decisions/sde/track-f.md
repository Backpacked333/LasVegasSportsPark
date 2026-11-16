# SDE hand-off: Track F (PA-08 open-amount register line)

Feature `glass-demo-amendments`. Status words follow §6.7: **Verified**, **Proposed**,
**Pending decision**. The requirement SPK-PAY-016 stays **Proposed**; its open values (the
categories, the ceilings, who may enter and who may approve) stay **Pending decision** (DEC-102).

## 1. What was built

### PA-08, SPK-PAY-016, capability `open_amount_lines`

- Database: `packages/db/migrations/0695_finance_pos_open_amount_lines.sql` (a line is a product
  line or an open-amount line; `pos_sale_lines_apply` replaced with every rule of 0686 kept and
  one added), `0696_finance_pos_line_approvals.sql` (`pos_line_approvals`, its guard, and two
  additional triggers on `pos_tenders` and `pos_sales`), `1310_reporting_pos_open_amount_lines.sql`
  (two read-only views); `packages/db/src/schema/finance-pos.ts`, `reporting.ts`.
- Contracts: `packages/contracts/src/api/finance-pos.ts` (`PosSaleLineKind`, `PosOpenAmountLine`
  on `PosSaleLine`, the add-line body as a union of the product body and the open-amount body,
  the approval body, `PosOpenAmountRules`, `PosSessionOpenAmountLine`, three new paths; the
  receipt line gains `description`).
- API (finance): `services/pos/pos-open-amount.service.ts` (enter, approve, rules read, session
  list), `services/pos/pos-sales.service.ts` (tender refused while a line waits; removal of an
  open-amount line; charges of a category through the same approved `tax_fee` path as a product;
  return journal by revenue category), `services/pos/pos-sale-finalizer.service.ts` (revenue per
  product kind and per revenue category; a sale is not paid while a line waits),
  `services/pos/pos-views.ts`, `controllers/pos.controller.ts`, `finance.actions.ts`
  (`finance.enter_open_amount_line`, `finance.approve_open_amount_line`), `finance.policy.ts`
  (`OPEN_AMOUNT_POLICY`, `OpenAmountPolicyContent`, the proposed default),
  `services/finance-policy.resolver.ts` (`openAmountRules`), `finance.module.ts`, `index.ts`
  (exports `PosOpenAmountService`).
- API (reporting): `reports/sales.report.ts` (open-amount lines listed apart, one row each).
- Staff: `apps/staff/src/screens/package-g/point-of-sale/OpenAmount.tsx` (entry form, approval
  step, line text, removal, session list), `SalePage.tsx`, `SessionPage.tsx`, `ReceiptPage.tsx`,
  `SaleForms.tsx` (return label); `features/pos-access-accounting/permission.tsx`, `labels.ts`,
  `CommandError.tsx` (the new refusals explained).
- Mobile: `apps/mobile/src/features/package-g/receipt-model.ts` (`receiptLineText`),
  `screens/pos-receipts/PosReceiptsScreen.tsx`.
- Tests: `apps/api/src/modules/finance/__tests__/pos-open-amount.spec.ts` (23 tests: the
  requirement, the ceiling in its three cases, the second person, permissions and validation,
  return and void, removal, the session list, the rules read, a card tender that settles while a
  line waits, a race test, seven database integrity tests, the approved policy version, the
  capability off);
  `apps/api/src/modules/reporting/__tests__/open-amount-lines.spec.ts`;
  `apps/api/src/__tests__/journeys/facility-register.spec.ts` (the gap kept with the switch off,
  the open-amount sale with it on, with a policy approved through the catalog API);
  `apps/staff/src/screens/package-g/point-of-sale/__tests__/OpenAmount.test.tsx` (11 tests);
  `apps/mobile/src/screens/pos-receipts/__tests__/PosReceiptsScreen.test.tsx` (one test added).
- Documents: the finance and reporting READMEs, the staff Package G README; the generated API
  document, client paths and permission matrix.

## 2. Deviations from the architect contract, and why

1. **No `pos_line_categories` table.** The categories and the ceilings are policy content read
   through the finance policy resolver, as the track brief directed: one approved catalog policy
   version carries the categories (code, label, revenue category, charge policy keys) and the
   ceilings (a default and one per staff role). The line snapshots the code, the label and the
   revenue category, and names the version (`policy_version_id`, null when the default applied).
2. **The policy family lives under the catalog kind `overpayment`, key `register-open-amount`.**
   Catalog's policy kinds are a closed list (contract and database check) owned by catalog, which
   another track was changing; none is for register rules. A finance-approved kind was chosen
   over the kind `approval`, which program and league managers approve. Nothing else reads that
   kind with that key. The choice is one constant (`OPEN_AMOUNT_POLICY` in `finance.policy.ts`).
   **Pending decision** for the architect: a kind of its own in catalog.
3. **The approval is not two columns on the line.** Sale lines are append-only (0607), so a line
   cannot be updated when it is approved. The approval is a row of `pos_line_approvals` and the
   line carries what it needs to be judged: the ceiling that applied and `approval_required`,
   which the database derives (`pos_sale_lines_open_amount_ceiling`). The API shows the approval
   on the line.
4. **`kind` gains `open_amount`** (the architect's `line_kind`); there is no `category_id`.
   `product_id` and `sku` became nullable; `name` stays required and holds the category label.
5. **An open-amount line is only ever removed**, never re-priced: its quantity is 1, and a
   different amount is a new line judged against the ceiling again.
6. **Removing an open-amount line needs no switch** (not even `point_of_sale`), and the approval
   needs `open_amount_lines`. Otherwise turning switches off could strand a sale that holds a
   card tender and an unapproved line. Changing a product line's quantity is gated as before.
7. **The block is on the tender and on the payment**, both in the service and in the database.
   A card tender taken before the line was entered can settle while the line waits: the sale then
   stays open, and removing the line pays it when the settled tenders cover what is left
   (`removeOpenAmountLine` calls `payIfCovered`), so it is not left open with nothing to pay and
   nothing to void.
8. **A ceiling per role, read as the highest of the caller's entering roles at the facility.**
   The approver has no ceiling of their own (**Pending decision**, DEC-102).
9. **Three reads and one command were added** beyond the add-line body: the approval command,
   `GET /pos-open-amount-rules` (the entry form needs the categories and the ceiling),
   `GET /pos-register-sessions/{id}/open-amount-lines` (the register report).
10. **The sales report gained four columns** (`revenueCategory`, `description`, `saleNumber`,
    `secondApproval`), null on rows of the other sources. The report shape is otherwise fixed
    (rows of scalars), so each open-amount line is a row of its own rather than a nested list.
11. **A reporting test that failed on the base was fixed**: `reporting_team_entries_v.status` is
    typed with the `waiting` state Track C added (`reporting-schema.spec.ts` compares the type
    with the base check). No report counts a waiting entry.
12. **Migrations used:** 0695, 0696, 1310. 0697 to 0699 are unused.

## 3. To register at integration

- Generated files were regenerated and committed on this branch and must be regenerated again
  after the merge: `docs/api/openapi.json`, `packages/api-client/src/generated/paths.ts`,
  `docs/package-a/permission-matrix.generated.md`. `packages/db/src/schema/index.ts` and
  `packages/contracts/src/api/index.ts` did not change (no new file).
- Shared test fixtures gained required fields: `line()` (`openAmount: null`) and `receipt()`
  lines (`description: null`) in `apps/staff/src/features/pos-access-accounting/__tests__/fixtures.ts`,
  and `receipt()` lines in `apps/mobile/src/features/package-g/__tests__/fixtures.ts`. A track or
  the demo data that builds its own `PosSaleLine` or `PosReceipt` literal needs them;
  `productId` and `sku` of a sale line are nullable now.
- No route, navigation entry, event, event handler or dependency was added. `App.tsx` is
  untouched.
- Kernel navigation (`kernel/authorization/navigation-areas.ts`, not edited): the two new actions
  fall in the finance area by their prefix. An organization that turns `open_amount_lines` on
  while `point_of_sale` is off would show the front desk a finance area with nothing to do in it.
- Documents not edited here: the "Today" paragraph of PA-08 in
  `docs/package-a/proposed-specification-amendments.md` and the register rows of
  `docs/package-a/legacy-parity-verification.md` describe the refusal; it now holds only while
  the switch is off.
- Catalog: a policy kind for register rules (deviation 2).
- Communications: nothing tells an approver that a line waits; the desk asks a second person.

## 4. What the demo dataset needs

Through the modules' services (all exported from `apps/api/src/modules/finance`):

1. Turn on `point_of_sale` (DEC-079) and `open_amount_lines` (DEC-102).
2. Two staff members with a person: one `front_desk` at the facility, one `general_manager` (or
   `finance_operator`). They must be different people.
3. `PosSetupService`: a register and an open session (and products for the ordinary lines).
4. Below the ceiling: `PosSalesService.create`, then `PosOpenAmountService.addLine` as the desk
   member, then `PosSalesService.addTender` in cash. With no policy approved, the proposed default
   applies (categories `field_damage_fee`, `lost_key`, `one_off_service`; desk ceiling 50.00).

   ```ts
   { description: 'Locker key 14 not returned', amountMinor: 1500, reasonCategory: 'lost_key' }
   ```

5. Approved above it: `addLine` as the desk member with the body below, then
   `PosOpenAmountService.approve` as the manager with a reason and the sale's current revision,
   then the tender. Naming the customer on the sale puts both lines on the customer's receipt in
   the app.

   ```ts
   { description: 'Goal net torn on field 3', amountMinor: 12000, reasonCategory: 'field_damage_fee' }
   ```

6. To show the approval step itself: leave a third sale open with a line above the ceiling and no
   approval.
7. Optional, to show an approved policy rather than the default: a catalog policy version of kind
   `overpayment`, key `register-open-amount`, approved by a finance operator, with this content
   (`chargePolicyKeys` and `currency` may be left out):

   ```ts
   {
     categories: [{ code, label, revenueCategory, chargePolicyKeys }],
     ceilings: { defaultMinor, byRole: { front_desk: 5000 } },
     currency: 'USD',
   }
   ```

## 5. Technical debt created

- The policy kind (deviation 2).
- Revenue categories are codes in the journal memo under `pos_revenue`, not ledger accounts: the
  accounting export maps them through that one account. Tips and deposits (questionnaire H9, G12)
  are not revenue and would need liability accounts, which the journal's account list does not
  have; none is assumed.
- `toPosSale` and the session list fall back to an empty string for an open-amount fact the
  database guarantees is present (the column types are nullable because product lines leave them
  null).
- The entry form and the approval step each read `GET /pos-open-amount-rules` on a sale page.
- An approver finds a waiting line by opening the sale, or through the session's list; there is
  no list across sessions and no notice.
- The staff session page lists open-amount lines only while the switch is on. Lines entered
  before it was turned off are still on their sales.
- `PosSaleFinalizer.payIfCovered` has a branch (a sale covered by tenders while a line waits)
  that no path reaches while the tender guard holds; it is there so an evidence path never throws.
- Observed, not changed (outside this track): changing a product line's quantity does not pay a
  sale whose settled tenders then cover its total; only the open-amount removal does.

## 6. Not verified

- No screen was looked at in a browser or on a device, in either theme. No stylesheet was written:
  the screens use existing classes and the shared kit, so the tokens of both themes apply. Staff
  tests run in jsdom, mobile tests in jest.
- The whole API suite was not run (by instruction); the report lists what was run.
- PostgreSQL: the open-amount spec, the reporting spec, the register journey and the two existing
  point-of-sale specs were run against a local PostgreSQL 16 through `TEST_DATABASE_URL`; nothing
  else was.
- The accounting export of a period that holds open-amount lines was not exercised.
- Card tenders: one path is tested (a card tender left unknown, a line above the ceiling added,
  the charge found by the reconciliation sweep, the line removed and the sale paid). A card
  return of an open-amount line and a card tender taken after an approval were not; they use the
  unchanged tender and return code.
