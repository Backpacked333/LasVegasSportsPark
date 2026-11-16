# ADR-004: A waiver is a policy kind whose acceptance is judged by key and rule, not by exact version

**Status:** Accepted
**Date:** 2026-11-14
**Feature:** glass-demo-amendments
**Author:** Architect and staff engineer

## Context

Forms today are policy versions; an acknowledgment satisfies only the exact version pinned on an
offering. PA-01 needs "current, lapsed or missing" for a person anywhere they take part, with a
renewal rule that is still open (DEC-095), paper acceptance that never looks like a customer's
digital signature (SPK-REG-009), and history kept across wording changes. PA-09 reuses it for
rental rosters.

## Decision

- New policy kind `waiver`. Its content carries the renewal rule (`reacceptOnNewVersion`,
  `renewEveryMonths`) and enforcement (`warn` or `block`, and who may override).
- An acceptance is an acknowledgment of a waiver version, now also carrying `method` (`digital` or
  `paper`) and, for paper, the date on the paper; the database refuses a paper acceptance not
  recorded by staff.
- A requirement names the waiver by policy key (on an offering, and on a rental offering for
  PA-09), not by version.
- One evaluation, `waiverStatus(person, key, at)`, exported through the catalog's policy port,
  answers `current`, `lapsed` or `missing` with the facts behind it. Registration, rosters,
  check-in and rental rosters all call it. An override of a block is its own append-only record.

## Alternatives Considered

| Alternative                            | Pros           | Cons                                                   | Why Not                                  |
| -------------------------------------- | -------------- | ------------------------------------------------------ | ---------------------------------------- |
| Keep using `form` with pinned versions | No new kind    | Every wording change re-asks everyone; no lapse notion | Contradicts what the facility does today |
| A separate waiver module and tables    | Clean slate    | Duplicates versions, approval, guardian signing rules  | The catalog already owns all of it       |
| Evaluate in each caller                | No port change | Four copies of the renewal rule                        | One rule must have one home              |

## Consequences

### Positive

- Guardian and staff signing rules, immutability and history are inherited unchanged.
- The renewal rule is data: answering DEC-095 is a policy version, not a release.

### Negative

- Two notions of "required document" on an offering (pinned forms, keyed waivers).

### Risks

- A caller treating `lapsed` as `current`. Mitigation: the port returns a discriminated result and
  each caller has a test per state.

## Dependencies

- Catalog migrations 0220 to 0229; entry 0881; PA-09 depends on it.
