# ADR-003: Price variants live on the price rule; every quote line stores its basis; extras are their own lines

**Status:** Accepted
**Date:** 2026-11-14
**Feature:** glass-demo-amendments
**Author:** Architect and staff engineer

## Context

PA-02 (per session), PA-03 (tiers, add-ons), PA-04 (member price) and PA-07 (uniform) all change
what a registration costs. Today one price rule is effective per offering per instant (a database
exclusion constraint), a quote line is `unit × quantity` for one basket line, and
`unique (quote_id, basket_line_id)` allows one quote line per basket line. SPK-PAY-002 requires a
quote to be reproducible later from stored facts.

## Decision

- The price rule stays the single source of an offering's price and gains: `pricing_basis`
  (`term` or `per_session`), an optional member price with the entitlement it requires, and child
  rows for tiers. Exactly one unit price results for a line; the order is tier, then member price,
  then per-session multiplication.
- Every quote line stores a `price_basis` document naming what was applied and the facts used
  (sessions counted and their ids, the tier, whether the member price applied and why).
- Add-ons and uniforms are extra lines of a basket line: `quote_lines` gains `line_kind`
  (`registration`, `addon`, `uniform`) and `source_id`; the uniqueness becomes
  `(quote_id, basket_line_id, line_kind, source_id)`. Order lines follow, tied to the same
  enrollment, so refund, transfer and reporting travel with the registration.
- Finance reads membership through a new port exported by enrollment; it never reads enrollment
  tables.

## Alternatives Considered

| Alternative                           | Pros                       | Cons                                                   | Why Not                                             |
| ------------------------------------- | -------------------------- | ------------------------------------------------------ | --------------------------------------------------- |
| Model variants as automatic discounts | Reuses the discount engine | A member price is not a discount; quote wording wrong  | SPK-PAY-015 wants the price stated, not a reduction |
| Several effective price rules at once | Flexible                   | Breaks the exclusion constraint that guards ambiguity  | Weakens a database guarantee                        |
| Add-ons as separate offerings         | No schema change to quotes | Separate enrollments; refund would not travel together | SPK-PAY-014 ties the add-on to its registration     |
| Recompute the basis when needed       | No new column              | Sessions change; the price could not be reproduced     | Violates SPK-PAY-002                                |

## Consequences

### Positive

- One place to read why a line cost what it did.
- Existing quotes are unchanged: `line_kind` defaults to `registration`, `price_basis` to null.

### Negative

- The quote calculator and checkout finalizer grow a second line kind.
- A migration replaces a unique constraint on an append-only table.

### Risks

- Double charging through an extra line and a registration line. Mitigation: database uniqueness
  as above plus a check that an extra line names its source.
- A paid price silently changing. Mitigation: the basis is written once with the quote; later
  session changes go through refund and credit policy, never through re-pricing.

## Dependencies

- Catalog migrations 0211 to 0219, enrollment 0521 to 0529, finance 0687 to 0694.
- PA-03 and PA-07 depend on PA-02 and PA-04 landing first (same files).
