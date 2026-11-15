# SRE: glass, demo mode and the ten amendments

Feature: `glass-demo-amendments`. Nothing in this work was run in production; this is what to
watch when it is.

## New background work

| Work                                                        | Where                           | If it stops                                             |
| ----------------------------------------------------------- | ------------------------------- | ------------------------------------------------------- |
| Sending confirmed scheduled messages (periodic job)         | communications                  | Confirmed messages stay unsent; the schedule shows them |
| Expiry of a place offered to a waiting team (outbox event)  | competition                     | Offers stay open past their time; capacity stays held   |
| Six message-schedule handlers on season and offering events | communications                  | Schedules are not created or do not follow date changes |
| Notices for place offers and waiting teams                  | communications (last fix round) | Captains are not told                                   |

All run on the existing worker (outbox dispatcher and periodic jobs), so the existing signals
cover them: outbox backlog and dead letters, periodic job failures, and the operational
exceptions each handler raises for its owner. A dead-lettered handler is replayed from the Today
screen as before.

## The new public surface

- Unauthenticated reads under `/v1/public/...`, rate limited per address (`public_views`,
  120 a minute by default) and cacheable for 30 seconds. A lobby display re-reads on its own and
  keeps showing the last schedule it received when it cannot reach the API.
- What to watch: rate-limited answers on these routes (a shared bucket means `TRUST_PROXY` is
  wrong: every visitor would look like one address), and read latency of the season view, which
  computes standings on read.
- Every failure of a public read looks the same to the caller ("not available") by design; the
  API log carries the reason.

## Capacity and data growth

- Stat tiles, toolbars and hero cards are glass bodies with a per-size filter; a screen holds a
  handful. Measured cold load before this work was 1.3 to 1.6 s throttled; not re-measured after
  it.
- `scheduled_messages`, `pos_line_approvals`, `waiver_overrides` and roster invitations are small
  and append-mostly. Session capacity pools gain one row per session of an offering sold by day.

## Operational rules a person on call should know

- A session's capacity is reconciled the first time a seat on it is reserved; if more people
  already attend than the session allows, the event `enrollment.capacity_below_commitments` is
  raised and nobody is removed.
- A public competition stops being served by itself if a division stops stating an adult age
  band. That is the rule working, not an outage.
- A register sale with an open-amount total above the entering person's ceiling takes no tender
  until a second person approves; the session's open-amount list shows what is waiting.

## Not verified

- No load test was run against the public reads or the message job.
- No alert thresholds were changed or added; the existing ones were not reviewed against the new
  work.
- Service levels for the public views and the lobby display are a **pending decision** (DEC-100).
