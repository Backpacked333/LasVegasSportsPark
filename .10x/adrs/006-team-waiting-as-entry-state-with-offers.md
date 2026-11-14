# ADR-006: Waiting is a state of the team entry; a freed place is offered through its own record

**Status:** Accepted
**Date:** 2026-11-14
**Feature:** glass-demo-amendments
**Author:** Architect and staff engineer

## Context

A full division refuses a team today. PA-10 wants the team to wait in order, hold no place, owe
nothing, be offered a freed place with an expiry, and stay out of schedules, standings and counts.
The individual waiting list (SPK-REG-008) lives in enrollment with capacity holds; team entries
live in competition, whose capacity is a trigger counting `applied` and `approved`.

## Decision

- `waiting` joins the team entry states (machine and database check), with `waiting_since`.
  A waiting entry has no division place; the capacity trigger does not count it. It still counts
  as the team's one live entry in the season.
- A place offer is a row of `team_entry_place_offers` (one open offer per entry, with expiry).
  An open offer counts toward the division's capacity so the place cannot be taken meanwhile.
  Expiry is an outbox event due at the expiry time, as hold expiry is.
- Accepting an offer moves the entry to `applied` in that division, into the existing approval
  and payment path (SPK-COMP-004). Staff choose the entry; the list always shows the order.
- Every existing query that enumerates `applied`, `approved` keeps doing so, which excludes
  waiting entries without change.

## Alternatives Considered

| Alternative                             | Pros               | Cons                                                | Why Not                     |
| --------------------------------------- | ------------------ | --------------------------------------------------- | --------------------------- |
| Reuse enrollment's waiting list         | Timed offers exist | Another module would own competition's capacity     | Module ownership (§4.2)     |
| A separate waiting-team table           | No state change    | A team could wait and apply at once; two lifecycles | One entry, one lifecycle    |
| A "waiting season" as the facility does | Matches today      | It is the workaround the amendment replaces         | PA-10 specifies the purpose |

## Consequences

### Positive

- Counts, schedules and standings need no change to exclude waiting teams.

### Negative

- The capacity trigger gains a second source (open offers).

### Risks

- Two staff offering the last place at once. Mitigation: the trigger locks the division row and
  counts open offers; a test runs the race under PostgreSQL.

## Dependencies

- Competition migrations 0467 to 0469; the competition state machines file.
