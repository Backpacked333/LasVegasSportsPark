# Legacy parity verification (Phase 0)

Status of this document: **Verified** where a row names a test or an inspection and its date; **Proposed** where it recommends work; **Pending decision** where the facility must answer first. Checked on 2026-11-13 against the `main` branch.

The facility runs today on DaySmart Dash. This document records what the assembled application does when it is driven through the facility's everyday scenarios, as opposed to what its modules implement in isolation. "Works" below means a named test drives the HTTP API of the whole application and passes. It does not mean a staff member has completed the task in the staff app: no screen was exercised in this pass (section 5).

## 1. How to re-run

```bash
pnpm --filter @sportspark/api exec vitest run src/__tests__/journeys/facility-register.spec.ts \
  src/__tests__/journeys/facility-class.spec.ts src/__tests__/journeys/facility-rental.spec.ts \
  src/__tests__/journeys/facility-league.spec.ts src/__tests__/journeys/facility-refund.spec.ts \
  src/modules/migration/__tests__/legacy-source-fixture.spec.ts
```

Each file asserts the behaviour that works and, separately, the behaviour that is missing. An assertion commented "recorded gap" documents present behaviour so that the gap cannot close or reopen unnoticed; it is not a requirement, and it is expected to be replaced when the matching amendment (`proposed-specification-amendments.md`) is accepted and built.

## 2. Scenarios

### 2.1 Front-desk register (`facility-register.spec.ts`)

| Step                                                                 | Result today                                                                     | Status                                    |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------- |
| A manager defines a product; desk staff cannot                       | Manager: created. Desk: refused (403)                                            | **Verified**                              |
| Desk opens a drawer with a float, sells 3 × 8.00 to a named customer | Sale total 24.00, open until paid                                                | **Verified**                              |
| Cash tender, receipt                                                 | Sale paid; the customer reads the receipt (product, quantity, tender, total)     | **Verified**                              |
| Drawer count at close                                                | Expected cash = float + cash sales; a matching count closes with zero difference | **Verified**                              |
| A negative-priced "discount" product, as used today                  | Refused: a product price cannot be below zero                                    | **Verified** (intended)                   |
| A one-off amount with a description (today: a 1.00 item × quantity)  | Refused: a sale line is a product and a quantity only                            | **Verified** gap, amendment PA-08         |
| Desk staff return an item for cash                                   | Refused (403): returns need the finance role                                     | **Pending decision** (questionnaire H)    |
| Card surcharge at the register (today: a 3% option)                  | No surcharge concept exists in code or specification (inspection)                | **Pending decision** (questionnaire A, G) |
| Gift cards                                                           | No gift card concept exists in code or specification (inspection)                | **Pending decision** (questionnaire G, P) |

Card tenders with a lost answer, tax by approved policy, drawer differences and the accounting export are covered by the existing `pos-to-accounting-export.spec.ts` (**Verified**, passing).

### 2.2 Class registration (`facility-class.spec.ts`)

| Step                                                         | Result today                                                                                                      | Status                                 |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| A parent puts two children into one class in a single basket | One quote, one checkout, two confirmed enrolments                                                                 | **Verified**                           |
| Sibling discount                                             | 10% is worked out once on the pair (4,000 on 40,000), split across both lines, and the arithmetic is on the quote | **Verified**                           |
| Which child carries the discount                             | Spread across all eligible lines; today's system may discount only the second child                               | **Pending decision** (questionnaire G) |
| Joining in week four of a ten-session term                   | Each child is charged the full term price; sessions already held do not reduce it                                 | **Verified** gap, amendment PA-02      |
| The same child added to the same class again                 | Refused (409, duplicate entitlement)                                                                              | **Verified**                           |
| A full class                                                 | Waiting list, timed offers and re-offers are covered by the existing `spk-reg-008-waitlist-offer.spec.ts`         | **Verified**                           |
| Member and non-member price on one class                     | No such price exists; a class has one base price plus discounts (inspection)                                      | **Verified** gap, amendment PA-04      |
| Camp price tiers and add-ons (early drop-off, lunch)         | Neither exists (inspection)                                                                                       | **Verified** gap, amendment PA-03      |

### 2.3 Field rental (`facility-rental.spec.ts`)

| Step                                                          | Result today                                                                     | Status                            |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------- | --------------------------------- |
| Desk staff enter a rental of a whole field for a named renter | Booking held, the field reserved, payment outstanding                            | **Verified**                      |
| Another renter asks for half of that field at the same time   | Refused (409) naming the overlapping reservation                                 | **Verified**                      |
| A scheduler enters a half-field rental on another day         | Accepted                                                                         | **Verified**                      |
| Another customer reads the renter's booking                   | Not found (404)                                                                  | **Verified**                      |
| A list of the renter's players, each with a signed waiver     | No such list exists; today it is kept as a made-up league (inspection)           | **Verified** gap, amendment PA-09 |
| The renter's name on a public calendar                        | There is no public facility calendar, so nothing is exposed and nothing is shown | **Verified** gap, amendment PA-06 |

Requests that need approval, recurring rentals and deposits are covered by the existing `spk-cond-003-rentals.spec.ts` (**Verified**, passing).

### 2.4 Adult league season (`facility-league.spec.ts`)

| Step                                                  | Result today                                                                               | Status                                                  |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| Staff create rules, a league, a season and a division | Created over the API; the season opens for entries                                         | **Verified**                                            |
| A captain enters a team                               | Entry recorded as applied; the captain cannot choose the division, staff place it          | **Verified**                                            |
| Staff approve two teams into a two-team division      | Approved and placed                                                                        | **Verified**                                            |
| A third team for the full division                    | Refused (409, division full); the entry stays applied and there is nowhere for it to wait  | **Verified** gap, amendment PA-10                       |
| A game is scheduled on a field                        | The game reserves the field                                                                | **Verified**                                            |
| The score is entered and made official                | Standings: winner 3 points, goals for and against, goal difference                         | **Verified**                                            |
| The public reads the standings without signing in     | Refused (401)                                                                              | **Verified** gap, amendment PA-06                       |
| Team fee: who pays, when, and what happens if unpaid  | Not exercised: both teams played with no fee recorded and empty rosters                    | **Pending decision** (questionnaire F, G); not verified |
| Uniform bought while registering                      | Rosters carry jersey numbers; no uniform product, size, order or stock exists (inspection) | **Verified** gap, amendment PA-07                       |

Pools, tie-breaks and bracket seeding are covered by the existing `tournaments.spec.ts` (**Verified**, passing). That test, like the other competition tests, creates its season and teams directly in the database; `facility-league.spec.ts` is the first test that sets a season up through the API alone.

### 2.5 Registration refund (`facility-refund.spec.ts`)

| Step                                      | Result today                                                                | Status                                 |
| ----------------------------------------- | --------------------------------------------------------------------------- | -------------------------------------- |
| Desk staff refund a registration payment  | Refused (403)                                                               | **Pending decision** (questionnaire L) |
| A general manager or finance refunds part | Refunded; the payment shows captured, refunded and still-refundable amounts | **Verified**                           |
| A refund of more than what is left        | Refused (409) with the amounts                                              | **Verified**                           |
| The child's place after a partial refund  | Unchanged; a refund moves money and withdrawal is a separate step           | **Verified**                           |
| The ledger after the refund               | Debits equal credits                                                        | **Verified**                           |

### 2.6 Import of source-shaped data (`modules/migration/__tests__/legacy-source-fixture.spec.ts`)

The fixture (`modules/migration/testing/legacy-source-fixture.ts`) is synthetic. Its record kinds and oddities are **Proposed**: they follow what the current system's screens show, because no export has been supplied (§1.4, **Pending decision**, questionnaire A1). It holds one person entered twice, two people with one name, a parent with two children and an authorized adult, paper and outdated waivers, 1.00 products used for open amounts, negative products used for discounts and refunds, a fake league used as a rental waiver list, a season used as a team waiting list, zero-price tournament groups and a team used as a bucket for individual children and a jersey price.

| Step                                                 | Result                                                                                                   | Status                                      |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Every source record is carried or listed with reason | People, households, parent links, invoices, balances, credits and waivers are staged; the rest is listed | **Verified**                                |
| First import                                         | Every staged row ends created, or skipped with a reason; nothing is charged and no message is sent       | **Verified**                                |
| Opening balances                                     | Equal the source to the cent (1,250.00 owed, 75.00 in credits)                                           | **Verified**                                |
| Reconciliation                                       | No money difference; the one row rejected in review is reported with who decided and why                 | **Verified**                                |
| Second import of the same data                       | Creates nothing and changes no count or total                                                            | **Verified**                                |
| The person entered twice                             | Imported as two people; no matching of duplicate records exists                                          | **Verified** gap, **Pending decision** (M6) |
| Seasons, divisions, teams and rosters                | Not staged: a staged season must name a competition and rule set the facility has not configured         | **Pending decision** (DEC-001, DEC-002)     |
| Register products                                    | Not staged: the staging contract has no product record                                                   | **Proposed** (set up afresh)                |
| Authorized-adult links                               | Not staged: which permissions such an adult holds is undecided                                           | **Pending decision** (E3, DEC-005)          |
| Invoices and waivers                                 | Kept as history on the staged row; no browsable order history or waiver record is created from them      | **Verified** gap (PA-01)                    |

An interrupted import resuming without creating a record twice is **Verified** separately, on smaller data, by `modules/migration/__tests__/apply-recovery.spec.ts`.

## 3. Requirements with no counterpart today

Found by searching the code and the master specification (inspection, 2026-11-13). Each has a drafted amendment.

| Need at the facility                               | In the code                                                                                                            | In the specification | Amendment |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | -------------------- | --------- |
| Liability waiver, versioned, with paper dates kept | Versioned forms and signed acknowledgements exist; nothing is called a waiver or carries a paper date                  | Not named            | PA-01     |
| Class price by sessions remaining                  | Absent                                                                                                                 | Absent               | PA-02     |
| Camp price tiers and add-ons                       | Absent                                                                                                                 | Absent               | PA-03     |
| Member and non-member price on one offering        | Absent                                                                                                                 | Absent               | PA-04     |
| Season email templates and sequences               | Staff compose and send single messages; no reusable template, no sequence                                              | Absent               | PA-05     |
| Lobby and public schedule views                    | Absent; open without sign-in are only the published offering list, token calendar feeds, provider callbacks and health | Absent               | PA-06     |
| Uniform purchase during registration               | Jersey numbers on rosters only                                                                                         | Absent               | PA-07     |
| Open-amount register line                          | Absent                                                                                                                 | Absent               | PA-08     |
| Rental-group rosters with waivers                  | Absent                                                                                                                 | Absent               | PA-09     |
| Team waiting list                                  | Absent (individual waiting lists exist)                                                                                | Absent               | PA-10     |

Two further gaps were found in this pass and have no drafted amendment because they depend on the facility's payment provider and policy answers: a card surcharge and gift cards (**Pending decision**).

## 4. What this pass changes in the plan

**Proposed.**

1. The league, class, rental, register and refund paths are sound enough to build on; none needs rework before the amendments.
2. The team-fee path is the largest unverified area of the core league workflow and should be verified, or built, before any other league work.
3. Three role boundaries differ from what desk staff do today (register returns, registration refunds, defining products). They are deliberate in the current design and should be confirmed or changed by the facility, not by code.

## 5. Not covered by this pass

- No staff-app or mobile screen was exercised; every result above is at the API. A scenario that works here can still be unusable at the desk.
- No real data was used, and no export of the current system has been seen. The fixture in 2.6 reflects its screens, not its export format.
- Reports were not reconciled against finance records beyond the ledger balance in 2.5.
- PostgreSQL was not used for the five journey files; they ran on the in-process database. The continuous-integration run covers PostgreSQL.
