# QA: glass, demo mode and the ten amendments

Feature: `glass-demo-amendments`. Full review: `.10x/reviews/2026-11-14-qa-report.md`
(traceability of every requirement clause to code and test, findings, and a resolution section).

## Verdict at review time

Not ready to be called complete: 1 blocker, 8 major, 14 minor findings. Each feature followed the
repository's rules on its own; the gaps were where separately built features meet.

## What was done about it

| Finding | What                                                                  | State                                    |
| ------- | --------------------------------------------------------------------- | ---------------------------------------- |
| B-1     | Six write routes unclassified for record authority                    | Fixed                                    |
| M-1     | A day selection honoured only by price, pools and the attendance list | Fixed: one rule, every reader            |
| M-2     | Waitlist unusable for a tiered offering                               | Fixed in the API and the customer basket |
| M-3     | Session capacity missed some participants                             | Fixed: reconciled under the pool locks   |
| M-4     | Required uniform enforced on one path only                            | Fixed in the API                         |
| M-5     | A team moved to waiting: players' paid places, nobody told            | In the last fix round                    |
| M-6     | Catalog advertised a price a quote would not give                     | Fixed                                    |
| M-7     | Nobody told of a place offer                                          | In the last fix round                    |
| M-8     | Cancel after a transfer used the rule's base price                    | Fixed                                    |

Screens still behind the API on two paths: the transfer screens do not let staff pick a tier, days
or a uniform size (the API's instruction is shown instead), and no screen converts a trial.

## Test results on the merged code

- Staff: 1,552 tests. Customer app: 1,395 tests. Browser smoke: 6.
- API: the complete suite ran after all six tracks merged (2 failures, both fixed: route
  classification and a test with random key order); it runs again in CI on every push, on PGlite
  and on PostgreSQL.
- Intermittent tests found and fixed at their cause (a control pressed or an option read before
  the second read it depends on): the glass smoke test, two rental roster tests, the team waiting
  list test, and a waiver test whose order depended on random keys.
- The intermittent `ContributionScreen` test from `main` is root-caused and fixed: the test helper
  waited for an idle query cache, but the answer reaches the screen in a later task, so the press
  landed while "Check again" was still busy. Reproduced 8 times in 200 repetitions before the fix,
  none in 600 after; the whole customer app suite then passed five runs in a row.

## Looked at in a browser

With the demo dataset, both themes: Today, Arrival, Registrations, People, Point of sale, Leagues,
Teams, Schedule, Finance, the sign-in role picker and tour, the public standings and schedule, the
lobby display. Contrast on glass measured at 4.5:1 or better on the screens checked.

## Not verified

- Any phone: the customer app's glass, the floating tab bar and every new customer screen.
- Safari and Firefox on real devices; a wall screen for the lobby display.
- Staff acceptance on the facility's own workstations (§6.3).
