# ADR-007: Demo mode is a build-time flag; its dataset is created through the modules' services

**Status:** Accepted
**Date:** 2026-11-14
**Feature:** glass-demo-amendments
**Author:** Architect and staff engineer

## Context

An unmerged branch adds demo mode: a `__DEMO__` build flag, a role picker, a banner, tours and
`pnpm demo`, with only six accounts as data, so every screen starts empty. The owner wants a
product that can be shown. Development sign-in must never ship (§5.2, §4.14); the release-bundle
checks enforce that today.

## Decision

- Keep the build-time flag and the bundle check: demo code is absent from a real build, and the
  check fails on demo markers.
- Add a demo dataset module under the API's development code that calls each module's exported
  services with a system principal, in the order a facility would (spaces, programs, prices,
  league, entries, fixtures, results, bookings, register, waiver, messages), idempotent by natural
  keys, refusing to run outside development with local identity. It turns the capabilities on.
- The tours gain steps for the ten amendments.

## Alternatives Considered

| Alternative                        | Pros            | Cons                                                   | Why Not                           |
| ---------------------------------- | --------------- | ------------------------------------------------------ | --------------------------------- |
| SQL fixture file                   | Fast to load    | Bypasses every invariant; rots with each migration     | Modules own their tables (§4.2)   |
| A runtime "demo" toggle            | No second build | Demo sign-in code would ship in production bundles     | Fails the bundle check on purpose |
| Use the migration fixture of PR 23 | Realistic shape | It is for import verification, not a walkable facility | Different purpose                 |

## Consequences

### Positive

- The dataset exercises the same commands as real use, so it doubles as a smoke test.
- Every screen can be looked at with data in both themes.

### Negative

- The dataset must be kept working as commands change.

### Risks

- Demo data mistaken for real. Mitigation: a separate database directory, the banner on every
  screen, synthetic names.

## Dependencies

- Depends on all ten amendments being merged (it uses them); runs in the last wave.
