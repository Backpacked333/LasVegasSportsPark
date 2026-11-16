# ADR-005: Public views are a separate read surface with their own shapes, codes and rate limit

**Status:** Accepted
**Date:** 2026-11-14
**Feature:** glass-demo-amendments
**Author:** Architect, staff engineer and security engineer

## Context

PA-06 asks for schedule, fixtures, results, standings and brackets without sign-in, and a lobby
display. Staff payloads carry renter names, people on commitments, card incidents and record ids.
Children's names must never appear (§4.14). Existing competition services refuse an anonymous
principal by construction. No public read route is rate limited today.

## Decision

- New controllers under `/v1/public/...`, marked public, addressed by organization slug and by
  public codes (random, per facility view, competition and season) rather than record ids.
- Each response is built from a dedicated query into a dedicated contract schema that has no
  field for a person, a booker, a contact or an internal id. A private booking is an occupied
  interval titled "Reserved". A fixture shows team names and score only, and only when its
  competition is public; otherwise the schedule shows "League game".
- A competition is private until a permitted staff member publishes it; publishing is refused when
  a division's criteria describe under-18 players (changeable when DEC-100 is answered).
- A new rate limit bucket `public_views` on every public read; responses carry a short public
  cache lifetime and the time they were computed.
- The lobby display and public pages are routes of the staff web application outside the session
  guard; they hold the last answer locally and say when it was fetched.

## Alternatives Considered

| Alternative                                 | Pros             | Cons                                            | Why Not                                    |
| ------------------------------------------- | ---------------- | ----------------------------------------------- | ------------------------------------------ |
| Mark existing staff reads public            | Least code       | Staff shapes leak names and ids                 | Fails §4.14 and SPK-SCHED-010              |
| Token-addressed feeds only (like calendars) | Already exists   | A lobby and a public page are not private feeds | Wrong audience                             |
| A separate public web application           | Clean separation | New deployable, new build, new hosting decision | Hosting is not selected (§5.2); not needed |

## Consequences

### Positive

- Nothing private can leak by a field being added to a staff schema later.
- The switch off answers "not available" on every public route.

### Negative

- Parallel read queries for schedule and standings to maintain.

### Risks

- Enumeration and scraping. Mitigation: random codes, rate limit, no listing of private things.
- A staff-typed event title containing a name. Mitigation: only titles from sources the system
  generated (offering name, team names) are shown; free-typed titles show the event kind.

## Dependencies

- Scheduling migrations 0305 to 0309, competition 0470 to 0479, core rate limit names.
