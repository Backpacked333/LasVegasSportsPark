# competition module

**Owns:** competitions (leagues and tournaments), rule-set versions, seasons, divisions, teams
(continuing identity), team entries (season participation), team roles, roster memberships, team
invitations, join requests, fixtures, availability responses (RSVP). Part 2 adds result revisions,
standings projections, brackets, discipline (incidents, decisions, suspensions, appeals), disputes
and the match-readiness evaluator.

**Specification:** §3.4 (SPK-COMP-001..005), §3.5 (SPK-CAP-001..005), §4.4 Competition (League,
Season, Division, Team, TeamEntry, RosterMembership) and Matches (Fixture), §4.5 "Team must
separate continuing identity from season entry", §4.8 (`POST /v1/team-entries/{id}/invitations`,
`POST /v1/fixtures/{id}/availability`), SPK-AT-002/003/013 (roster parts), SPK-FIX-005.

**Migration range:** `packages/db/migrations/0400_competition_*.sql` … `0499` (part 1 uses `0400`;
part 2 starts at `0450`).

**Depends on:** identity (`PeopleService` for minimal person facts, date of birth for age
eligibility, verified contact points for contact invitations), scheduling (`EVENT_SCHEDULING_PORT`
for fixture events with team commitments; consumes `scheduling.event_changed`). It never writes
identity or scheduling tables (§4.2).

**Status: implemented (part 1, core model)** — verified by `apps/api/src/modules/competition/__tests__`
and the unit specs next to the code (`competition.state-machines.spec.ts`,
`competition.rules.spec.ts`). Statements below are verified unless marked proposed or pending.

## Kernel registration — verified

- `TEAM_AUTHORITY_IMPL` → `TeamAuthority.hasTeamRole`: a person holds a role on a season entry
  exactly when a `team_roles` row is effective at the clock. Roles are hierarchical downward
  (captain satisfies co_captain and member checks; co_captain satisfies member checks). A co-captain
  satisfies **captain** checks only when the season's rule set says so
  (`roster.coCaptainMayActAsCaptain`, proposed default `false`, DEC-002). Reads go through the
  caller's transaction, so a role assigned earlier in the same command counts. Registered with
  `useExisting`; the kernel resolves it lazily at call time.
- Outbox handler `competition.sync_fixture_schedule` on `scheduling.event_changed`: keeps a
  fixture's copied instants in step when scheduling moves the event, and marks it `postponed` when
  scheduling cancels the event directly. Idempotent under replay (revision-guarded, no-op when
  nothing changed).

## Tables (migration `0400_competition_core.sql`)

| Table                    | Purpose                                                                                                                                                                                                                                                                                                                      |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `competitions`           | name (unique per organization), kind `league/tournament`, `sport_format` `outdoor/indoor_boarded/futsal/small_sided_other`, status `draft → active → archived`                                                                                                                                                               |
| `rule_sets`              | Immutable versions (`forbid_mutation`): `(name, version)` unique, `supersedes_rule_set_id` chains versions (version 1 ⇔ no predecessor), `content` jsonb validated per format by `RuleSetContentSchema` + `ruleSetFormatIssues` (SPK-COMP-002: every listed field; sections irrelevant to the format are null)               |
| `seasons`                | competition, one rule-set version of the competition's format, `starts_on/ends_on`, `registration_offering_ref` (catalog id as text, no cross-module key), registration window, status `draft → open → active → completed → archived`, revision                                                                              |
| `divisions`              | season, documented criteria jsonb (age band, level, category, format; DEC-048), `facility_id` (location, composite FK), `capacity_team_entries`; `unique (organization_id, season_id, id)` so entries and fixtures reference a division of their own season                                                                  |
| `teams`                  | Continuing identity (§4.5): name, colors, creator; status `active/inactive/archived`                                                                                                                                                                                                                                         |
| `team_entries`           | One team's participation in one season: status `applied → approved \| rejected \| withdrawn` (approved → withdrawn) with the matching facts, `division_id` (null until placed), `financial_status_ref` (set by finance), `eligibility_status`, `renewed_from_entry_id`, revision. Roster completion is derived, never stored |
| `team_roles`             | Effective-dated `captain/co_captain/member`; partial unique: one open role per person per entry                                                                                                                                                                                                                              |
| `roster_memberships`     | Effective-dated rows `invited/requested/active/guest/substitute/removed`; removal sets `effective_to`, `status_before_removal`, `removed_*` and never deletes (SPK-COMP-005); partial unique: one open row per person per entry; jersey numbers unique among open playing rows; `eligibility_snapshot` kept with the row     |
| `team_invitations`       | Inviter, recipient (person **or** contact, check-constrained), message, token hash, expiry, acceptance, revocation, placeholder roster row; one pending per recipient per entry                                                                                                                                              |
| `join_requests`          | Person, requester, decision facts, placeholder roster row; one pending per person per entry                                                                                                                                                                                                                                  |
| `fixtures`               | season, division, round, `home_entry_id`, `away_entry_id` (null = bye, check home ≠ away), `scheduling_event_id` (composite FK to scheduling `events`, unique), copied `scheduled_start/end`, status `unscheduled/scheduled/played/forfeit/canceled/abandoned/postponed` (`scheduled` requires an event), revision           |
| `availability_responses` | RSVP `available/unavailable/tentative/no_response` per `(fixture, person)` with the side, response instant and recorder; RSVP is neither attendance nor eligibility (SPK-CAP-003)                                                                                                                                            |

Invariants enforced by the database (tests in `__tests__/competition-schema.spec.ts`): composite
`(organization_id, …)` foreign keys everywhere; one live entry per team per season (partial unique,
§4.7 invariant 2); division capacity on placement (`team_entries_division_capacity` trigger with a
row lock on the division, §4.7 invariant 3); one open role and one open roster row per person per
entry; state check constraints listing exactly the machine states; status/fact agreement on entries;
rule sets append-only.

## Endpoints (`/v1`, contracts in `packages/contracts/src/api/competition.ts`)

| Method         | Path                                                             | Who (action)                                                                                                                                                                                                                                |
| -------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST/GET/PATCH | `/competitions[/{id}]`                                           | league_manager, general_manager, system_administrator manage (`competition.manage_competitions`); every staff role and customers read                                                                                                       |
| POST/GET       | `/rule-sets[/{id}]`                                              | manage: posting an existing name creates the next version (never an edit); `latestOnly=true` lists current versions                                                                                                                         |
| POST/GET/PATCH | `/seasons[/{id}]`                                                | manage; PATCH moves status through the machine with `expectedRevision`; the rule set changes only while `draft`                                                                                                                             |
| GET            | `/seasons/{id}/fixtures`                                         | staff and customers (`competition.read_competitions`); paginated, filters division/entry/status/window                                                                                                                                      |
| POST/GET/PATCH | `/divisions[/{id}]`                                              | manage; capacity cannot drop below placed entries                                                                                                                                                                                           |
| GET/PATCH      | `/teams/{id}`                                                    | staff, role holders and roster players read; captain of a live entry or league administration edit (`competition.manage_team`)                                                                                                              |
| POST           | `/team-entries`                                                  | captain (adult customer, season `open` and inside the registration window) creates a new team's entry or renews with `renewFromEntryId` (captain role on the prior entry); staff may enter a `teamId`, name the captain and place the entry |
| GET            | `/team-entries?seasonId`                                         | staff (`competition.list_team_entries`): what is missing and who resolves it (SPK-COMP-004)                                                                                                                                                 |
| GET            | `/team-entries/{id}`                                             | captain workspace (SPK-CAP-001): staff in scope, role holders, roster players, guardians with `view`; others NOT_FOUND                                                                                                                      |
| POST           | `/team-entries/{id}/approve`, `/reject`                          | league administration (`competition.approve_team_entry`); approve may place in a division                                                                                                                                                   |
| POST           | `/team-entries/{id}/withdraw`                                    | captain (team role) or league administration                                                                                                                                                                                                |
| GET/POST       | `/team-entries/{id}/roster`                                      | GET: effective roster at `at` (history for captains/staff); POST: add/remove with effective dates (`competition.manage_roster`)                                                                                                             |
| GET            | `/team-entries/{id}/eligibility?personId`                        | captain/co-captain or staff: explainable evaluation (SPK-CAP-004)                                                                                                                                                                           |
| POST           | `/team-entries/{id}/invitations`                                 | captain or staff (`competition.invite_player`, §4.8); token returned once; eligibility preview as codes only (SPK-CAP-002)                                                                                                                  |
| POST           | `/team-invitations/{id}/accept`, `/revoke`                       | accept: invited person or a guardian holding `register` (token required); revoke: captain or staff                                                                                                                                          |
| POST           | `/team-entries/{id}/join-requests`, `/join-requests/{id}/decide` | request: the player or a guardian with `register`; decide: captain or league administration                                                                                                                                                 |
| POST/GET/PATCH | `/fixtures[/{id}]`                                               | league administration (`competition.manage_fixtures`); PATCH actions schedule/reschedule/postpone/unschedule/cancel/edit; GET: staff, roster players, guardians with `view`                                                                 |
| POST           | `/fixtures/{id}/availability`                                    | the player, a guardian with `register`, or front desk/league manager/support (`competition.respond_availability`, §4.8)                                                                                                                     |

Every consequential POST/PATCH is `@Idempotent()` and zod-validated; every write runs in
`UnitOfWork.run` with an audit record and outbox follow-ups. Creating or renewing an entry and every
fixture command create an `operation` (`GET /v1/operations/{id}`); fixture scheduling runs the
scheduling port between two transactions so a conflict leaves the fixture `unscheduled` and the
operation `failed` with the reason (§4.9, §4.12).

## Ports (`ports.ts`, provided by `CompetitionModule`)

- `TEAM_ENTRY_QUERY_PORT` → `findTeamEntry`, `listSeasonEntries`, `entriesOfPerson(at)` (ids and
  readiness facts only).
- `ROSTER_PORT` → `effectiveRoster(organizationId, teamEntryId, at)` (SPK-COMP-005: the roster as
  it was at an instant).
- `FIXTURE_PORT` → `findFixture`, `listSeasonFixtures`, `fixturesOfEntry`, `recordOutcome`
  (results in part 2 move a fixture to played/forfeit/abandoned inside the caller's transaction).
- `ELIGIBILITY_PORT` → `evaluatePlayer(organizationId, teamEntryId, personId, at, options)`:
  explainable reasons (code, severity blocking/warning/info/unknown, source record, responsible
  role, required action — SPK-READY-003). Unknown evidence is never a pass (SPK-READY-002).
- `SUSPENSION_CHECK_PORT` (interface + `SUSPENSION_CHECK_IMPL` token): discipline (part 2)
  registers the implementation; until then no suspensions exist. Resolved lazily through the
  kernel's `lazyPort`.
- `READINESS_CHECK_REGISTRY` → `registerCheck(name, fn)` / `checks()`: workforce, finance and
  facilities register fixture readiness checks; the evaluator that runs them is part 2.
- Fixtures for downstream tests: `testing/competition-fixtures.ts` (`createRuleSetFixture`,
  `createCompetitionFixture`, `createSeasonFixture`, `createDivisionFixture`,
  `createTeamEntryFixture`, `assignTeamRoleFixture`, `addRosterMemberFixture`,
  `createFixtureFixture`); use with `createTestApp({ imports: [CompetitionModule], principalResolver: 'module' })`
  and the identity fixtures for people.

## Events (`competition.events.ts`)

`competition.competition_created/updated`, `competition.rule_set_created`,
`competition.season_created/updated`, `competition.division_created/updated`,
`competition.team_created/updated`, `competition.team_entry_created` (finance and enrollment react:
nothing is charged here, SPK-CAP-005), `competition.team_entry_status_changed`,
`competition.team_role_changed`, `competition.roster_changed` (one per row opened or closed),
`competition.team_invitation_created/resolved` (communications delivers; recipients are resolved by
id or contact, never carried in the payload), `competition.join_request_created/decided`,
`competition.fixture_created`, `competition.fixture_changed` (status or time change; readiness and
communications re-evaluate), `competition.availability_responded`. Payloads carry identifiers only.

## Behaviour notes — verified

- Eligibility (`services/eligibility.service.ts`) evaluates, for the membership being considered
  (active, guest or substitute — a guest label bypasses nothing, SPK-CAP-004): person status, entry
  and season state, the division age band at the rule set's reference date computed from the
  identity date of birth (§4.5), roster limits (regular places; guests have their own concurrent
  limit), substitutes/guests allowed, required league approval, multi-team restrictions
  (entries per season, same division, cross division), suspensions through the port
  (SPK-AT-013) and, for a fixture, the opposing roster and overlapping scheduled fixtures.
- Renewal (SPK-AT-003, SPK-CAP-005) creates a new entry for the same continuing team, prefilled from
  the prior entry and returning prior players as suggestions; the prior season's rows are not
  touched (tested byte-identical) and nothing is charged.
- Captains see display names and readiness codes only; dates of birth, contacts, payment
  instruments and notes never appear in competition responses (SPK-CAP-002).
- Pending invitations expire lazily on an acceptance attempt by the token holder.

## Policy defaults (proposed, pending operator decisions §6.6)

- Rule-set defaults per format (`proposedRuleSetContent`): DEC-002 / POL-026 / POL-032. They are
  configuration a league manager starts from; evaluation always reads the season's rule-set version.
- A co-captain does not satisfy captain checks (`coCaptainMayActAsCaptain: false`).
- A team captain must be an adult (pending the guardian/child-account policy).
- Invitation lifetime 7 days (`TEAM_INVITATION_DEFAULT_HOURS`); the raw token is returned once to
  the inviter because no messaging provider is selected (§5.2).
- The `tentative` RSVP state is accepted (DEC-064 pending).

## Known gaps (part 2 and later)

- Results, standings, brackets, discipline (and the real `SUSPENSION_CHECK_IMPL`), disputes and the
  readiness evaluator (`GET /v1/fixtures/{id}/readiness`) are part 2; `FIXTURE_OBLIGATION_IMPL` for
  schedule publication (SPK-FIX-002) and the fixture generator (SPK-FIX-001..004) are not here.
- `team_entries.eligibility_status` is recorded (`pending` by default) but no command moves it yet;
  the entry-level evaluation belongs with placement (§3.6) and readiness in part 2.
- No background expiry of invitations; no transfer command (a transfer is a removal plus an
  addition with effective dates).
- Team roles beyond the founding captain are written by fixtures and part 2 (role handover command
  pending).
- Jersey numbers are unique per entry but not validated against a rule-set range.
