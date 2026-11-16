# Security: glass, demo mode and the ten amendments

Feature: `glass-demo-amendments`. Full review: `.10x/reviews/2026-11-14-security-review.md`
(findings, what was checked and found sound, what was not examined, and a resolution line per
finding).

## Outcome

No critical or high finding. Four medium and seven low findings; all four medium and five low
ones are fixed with tests, two low ones are accepted pending a product decision.

| Finding | What                                                      | State                               |
| ------- | --------------------------------------------------------- | ----------------------------------- |
| M-1     | Rental roster: naming, showing and joining another person | Fixed (service and database)        |
| M-2     | Youth competitions could be made public under some names  | Fixed: fails closed on age band     |
| M-3     | Public rate limit key behind a proxy                      | Fixed: production must name proxies |
| M-4     | Open-amount ceiling evaded by splitting lines             | Fixed per person per sale           |
| L-1     | Roster invitation token stored and sent in a query string | Fixed                               |
| L-2     | Public codes are listed by the directory                  | Accepted, pending DEC-100           |
| L-3     | Public schedule answered for any date                     | Fixed: a window around today        |
| L-4     | Waiver override scope and lifetime                        | Fixed                               |
| L-5     | Existence oracles in three reads                          | Fixed                               |
| L-6     | A sequence manager can message any season's teams         | Accepted, pending DEC-099           |
| L-7     | Demo API listened on every interface                      | Fixed: this machine only by default |

## Decisions taken while fixing

- A public competition must be positively adult: every division states an age band with a
  minimum age of 18 or more. Wording is only an extra refusal. A competition that stops meeting
  the rule stops being served.
- A renter names by person only themselves and people they may register; everyone else is invited
  by contact and answers for themselves. Staff keep naming by person.
- Production refuses to start without an explicit, bounded proxy trust setting. **Deploy impact**:
  set `TRUST_PROXY` on the API and the worker before deploying this branch.
- The development API (which signs anyone in as a seeded account) answers this machine only.

## Residual risk, stated plainly

- Two desk users can each enter up to their ceiling on one sale; totals across sales of a session
  are visible in the session report and not limited (DEC-102).
- A contact invitation to a rental roster is not matched to a verified contact point (DEC-103).
- The under-18 wording check does not recognise two-digit birth years or other languages; the
  age band rule is the control.
- Nothing here was verified against a deployed host, a real proxy, or PostgreSQL beyond what CI
  runs.

## Not examined by the review

Identity staff invitations and care notes from `main`, refund arithmetic for add-on and uniform
lines, the mobile app's public and invitation screens, kernel additions other than rate limiting
and configuration.
