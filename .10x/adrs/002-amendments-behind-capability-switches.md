# ADR-002: The ten amendments ship behind capability switches with proposed defaults

**Status:** Accepted
**Date:** 2026-11-14
**Feature:** glass-demo-amendments
**Author:** Architect and staff engineer

## Context

PA-01 to PA-10 are **Proposed** requirements whose open values wait on decision records DEC-095 to
DEC-104. The owner asked for them to be built now. The repository already has conditional
capabilities (DEC-016): a closed list of ids in contracts and in a database check, enforced inside
commands, reported by `GET /v1/me/permissions`, gated in both clients.

## Decision

Add ten capability ids, one per amendment, `enforcement: 'commands'`, each naming its own decision
record. Every new command requires its capability inside its unit of work; every new screen is
gated. Reads of records that already exist stay available when a switch is turned off. Where an
amendment changes an existing computation (the price of a line, the capacity of a division), the
existing behaviour is exactly preserved while the switch is off. Assumed values are configuration
(policy content, per-offering settings) wherever the amendment calls them open, never constants.

All ten ids land in one change (contracts list, one core migration widening both checks, client
presentation), before any track starts, so parallel tracks do not edit the list.

## Alternatives Considered

| Alternative            | Pros               | Cons                                             | Why Not                                   |
| ---------------------- | ------------------ | ------------------------------------------------ | ----------------------------------------- |
| Always on              | Less code          | Ships undecided facility rules to every operator | Contradicts §6.7 and the decision records |
| One switch for all ten | One id             | An operator cannot accept one and reject another | The amendments are accepted one by one    |
| Build-time flags       | No database change | Not per organization; invisible to the clients   | The capability mechanism already exists   |

## Consequences

### Positive

- An operator can accept amendments one at a time; nothing changes for one that has accepted none.
- The gap tests of pull request 23 keep proving today's behaviour with the switch off.

### Negative

- Every changed computation has two paths to test.
- Ten more rows in the permission matrix and the capability screen.

### Risks

- A read path that forgets the switch could show a half-configured feature. Mitigation: a journey
  test per capability with the switch off.

## Dependencies

- Core migration `0020`; `packages/contracts/src/capabilities.ts`; `packages/api-client/src/capabilities.ts`.
- Every track depends on this landing first.
