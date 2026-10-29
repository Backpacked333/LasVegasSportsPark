# competition module

**Owns:** competitions (leagues and tournaments), rule-set versions, seasons, divisions, teams
(continuing identity), team entries (season participation), team roles, roster memberships, team
invitations, join requests, fixtures, availability responses (RSVP) — part 1; result revisions,
standings projections, bracket nodes, fixture specifications, solver runs, incidents,
disciplinary decisions, suspensions, disputes and appeals — part 2. Match readiness is derived on
every read and never stored.

**Specification:** §3.4 (SPK-COMP-001..005), §3.5 (SPK-CAP-001..005), §3.8 (SPK-FIX-001..005),
§3.9 (SPK-READY-001..004), §3.11 (SPK-RESULT-001..005), §3.12 (SPK-DISC-001..005), SPK-STAFF-005,
§4.4 Competition, Matches (Fixture, ResultRevision, StandingsProjection, BracketNode) and
Discipline (Incident, DisciplinaryDecision, Suspension, Appeal), §4.5 "Team must separate
continuing identity from season entry", §4.6 Result machine, §4.7 invariants 8 and 9, §4.8
(`POST /v1/team-entries/{id}/invitations`, `POST /v1/fixtures/{id}/availability`,
`GET /v1/fixtures/{id}/readiness`, `POST /v1/fixtures/{id}/results`, `POST /v1/results/{id}/publish`),
SPK-AT-002/003/010/011/013/014.

**Migration range:** `packages/db/migrations/0400_competition_*.sql` … `0499` (part 1 uses `0400`,
part 2 uses `0450`; `0451` tightens the result history guard; stage 3 adds `0454` … `0460`).

**Depends on:** identity (`PeopleService` for minimal person facts, date of birth for age
eligibility, verified contact points for contact invitations), scheduling (`EVENT_SCHEDULING_PORT`
for fixture events with team commitments; `ScheduleDraftsService` to open generated proposals as
drafts; `EventsService`, `ResourcesService`, `ClosuresService` for readiness; consumes
`scheduling.event_changed`). It never writes identity or scheduling tables (§4.2).

**Status: implemented (parts 1 and 2, stage-3 items CMP-01 … CMP-15)** — verified by
`apps/api/src/modules/competition/__tests__`
and the unit specs next to the code (`competition.state-machines.spec.ts`,
`competition-matches.state-machines.spec.ts`, `competition.rules.spec.ts`,
`matches/fixture-generator.spec.ts`, `matches/standings.calculator.spec.ts`), under PGlite and
PostgreSQL (`TEST_DATABASE_URL`). Statements below are verified unless marked proposed or pending.

## Kernel registration — verified

- `TEAM_AUTHORITY_IMPL` → `TeamAuthority.hasTeamRole`: a person holds a role on a season entry
  exactly when a `team_roles` row is effective at the clock. Roles are hierarchical downward
  (captain satisfies co_captain and member checks; co_captain satisfies member checks). A co-captain
  satisfies **captain** checks only when the season's rule set says so
  (`roster.coCaptainMayActAsCaptain`, proposed default `false`, DEC-002). Reads go through the
  caller's transaction, so a role assigned earlier in the same command counts. Registered with
  `useExisting`; the kernel resolves it lazily at call time.
- `FIXTURE_OBLIGATION_IMPL` (scheduling publication step 4, SPK-SCHED-006, SPK-FIX-002) →
  `FixtureObligationsService.verify`: inside the publication transaction, a published game that
  names a fixture must correspond to a live fixture of the organization that is not a bye, not
  closed and not already scheduled elsewhere (blocking); a game without a fixture is a remaining
  obligation for the scheduler; for every season the draft touches, the fixtures still
  unscheduled are reported with owner `league_manager` and a deadline (proposed 7 days, capped at
  the season end). In the same transaction an incomplete season opens one
  `competition.incomplete_season` operational exception (league manager queue, that deadline); a
  later publication that leaves nothing unscheduled resolves it (SPK-AT-010 step 5).
- `SUSPENSION_CHECK_PORT` (part 1's eligibility consults it, SPK-AT-013): answered by this module's
  `DisciplineService` (active, approved suspensions in scope); an implementation registered under
  `SUSPENSION_CHECK_IMPL` elsewhere takes precedence.
- Outbox handler `competition.sync_fixture_schedule` on `scheduling.event_changed`: keeps a
  fixture's copied instants in step when scheduling moves the event, and marks it `postponed` when
  scheduling cancels the event directly. Idempotent under replay (revision-guarded, no-op when
  nothing changed). The same handler copies the venue read model (CMP-04, below).
- Periodic job `competition.expire_team_invitations` (CMP-07, IF-24; interval 60 s, failure owner
  `league_manager`) registered with the kernel `PeriodicJobRegistry`.
- Outbox handler `competition.follow_person_merge` on `identity.persons_merged` (CMP-08, failure
  owner `league_manager`).

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

## Tables, part 2 (migration `0450_competition_matches.sql`)

| Table                    | Purpose                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `result_revisions`       | Per fixture `revision_no`, status `draft → submitted → official → superseded` (§4.6 `ResultMachine`, check constraint), classification `completed/forfeit/canceled/abandoned/postponed/disputed` (SPK-RESULT-002), scores, forfeiting entry, details (cards, abandonment, incident ids, notes, dispute answered), submitted/returned/published/superseded actor and instant, `supersedes_revision_id`, reason |
| `standings_projections`  | Append-only (`forbid_mutation`): season/division, rule set id **and version**, `computed_at`, the official result ids it derives from, rows (position, played, won, drawn, lost, goals, points, fair play, forfeits) and tiebreak explanations (SPK-RESULT-003)                                                                                                                                               |
| `bracket_nodes`          | Season/division, round, slot (unique), source rule per side (`seed`, `winner_of`, `loser_of`, `bye`), entries, fixture (unique), winner, publication instant and actor                                                                                                                                                                                                                                        |
| `fixture_specifications` | Division, facility, games per team, opponent frequency, dates, blackouts, byes allowed, minimum rest, allowed start times, match duration, required resources, playoff structure, fairness preferences with `hard` flags (SPK-FIX-001/003)                                                                                                                                                                    |
| `solver_runs`            | Specification snapshot, rule-set version, search settings, outcome `feasible/proven_optimal/proven_infeasible/no_proposal_within_limit` (a proven-infeasible run has no proposal), proposal, completeness report, explanation, dry run, schedule draft, fixtures created, operation (SPK-FIX-004)                                                                                                             |
| `incidents`              | Kind `card/misconduct/complaint/operational/injury`, fixture/season/competition/subject/entry/result revision, card kind (exactly for cards), severity, safe `summary`, restricted `narrative` (SPK-DISC-004; operational facts only, SPK-DISC-005), evidence references, reporter, status `open → under_review → closed`                                                                                     |
| `disciplinary_decisions` | Subject, incident, rule-set version applied, basis, decision `no_action/warning/suspension/other`, decider, status `issued → overturned` with actor and reason (SPK-DISC-003)                                                                                                                                                                                                                                 |
| `suspensions`            | Subject, decision, basis, scope `all` or named `competition_ids` (never assumed), effective period and/or match count with `matches_served` and `served_fixture_ids`, completion criteria, status `proposed → active → served`, `overturned`, approval, `appeal_status`, source `manual/red_card/yellow_accumulation` with source fixture and result revision (SPK-DISC-002/003)                              |
| `disputes`               | Fixture, disputed revision, submitting entry and role, submission instant and deadline (rule set `protestDeadlineHours`), reason, evidence, status `submitted → under_review → decided`, `withdrawn`, reviewer, decision `upheld/rejected`, publication consequence (SPK-RESULT-005)                                                                                                                          |
| `appeals`                | Exactly one target (decision, suspension or dispute), subject, grounds, evidence, submitter, status `submitted → under_review → granted/denied`, `withdrawn`, reviewer and reason                                                                                                                                                                                                                             |

Invariants enforced by the database (tests in `__tests__/matches-schema.spec.ts`): exactly one
official result per fixture and one revision in progress (partial unique indexes, §4.7 invariant
8); an official or superseded row names its publisher and publication instant; a trigger lets an
official row change only to `superseded` (scores, classification, details, actors, reason and
publication instant unchanged), makes superseded rows immutable and refuses every delete (§4.7
invariant 9); standings projections are append-only; suspension terms (period or count, named
competitions, approval before `active`, never more served than counted); one rule-set proposal per
person, fixture and rule; one open appeal per target; composite `(organization_id, …)` foreign keys
on every reference. Migration `0451_competition_result_history_guard.sql` (same test file) also
freezes, when an official row is superseded, its actor person ids, return (review) facts, the
pointer to what it superseded, organization and creation time, and requires it to name the
superseding revision; both chain pointers must name a revision of the same fixture (composite
foreign keys on `(organization_id, fixture_id, …)`), never the row itself; only an official row can
become superseded. Publication authority itself is enforced by the publish action, not the database.

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

Part 2 (contracts in `packages/contracts/src/api/competition-matches.ts`):

| Method   | Path                                                              | Who (action)                                                                                                                                                                                                                                                                                                                                                |
| -------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST     | `/fixtures/{id}/results`                                          | an official holding an accepted assignment (`ASSIGNMENT_CHECK_PORT`) whose role the rule set lists in `submitRoles`, or league administration (`competition.submit_result`, SPK-STAFF-005): draft → submitted with scores, classification, cards, incidents, abandonment details; a fixture with an official result receives a correction (reason required) |
| GET      | `/fixtures/{id}/results`, `/results/{id}`                         | staff see every revision; roster players and guardians with `view` see official and superseded ones only; others NOT_FOUND                                                                                                                                                                                                                                  |
| POST     | `/results/{id}/return`, `/results/{id}/submit`                    | return: league administration (`competition.review_result`, submitted → draft with reason); resubmit: the submitter roles (draft → submitted)                                                                                                                                                                                                               |
| POST     | `/results/{id}/publish`                                           | `competition.publish_result`: `league_manager` plus the rule set's `resultApproval.approveRoles` (§4.7 invariant 8, DEC-065); recalculates standings, moves the fixture, serves and proposes suspensions, progresses the bracket; see corrections below                                                                                                     |
| GET      | `/seasons/{id}/standings?divisionId`                              | staff and customers: the latest projection (official league-phase results only), or a live computation when none is stored                                                                                                                                                                                                                                  |
| POST/GET | `/seasons/{id}/bracket-nodes`, POST `/bracket-nodes/{id}/publish` | manage: league administration; read: staff see all nodes, customers published ones                                                                                                                                                                                                                                                                          |
| POST     | `/divisions/{id}/fixture-specifications`                          | league administration (`competition.manage_fixture_specifications`); 400 for a specification error (dates outside the season, games per team ≠ (teams − 1) × frequency, a team preference without its approved entry or times, an unapproved convenience preference)                                                                                        |
| GET      | `/fixture-specifications/{id}`, `/solver-runs/{id}`               | league administration                                                                                                                                                                                                                                                                                                                                       |
| POST     | `/fixture-specifications/{id}/generate`                           | league administration (`competition.generate_fixtures`): records a solver run; unless `dryRun`, creates the fixtures (obligations, byes included) and opens the scheduled games as a scheduling draft (SPK-FIX-005); an `operation` tracks both steps                                                                                                       |
| GET      | `/fixtures/{id}/readiness`                                        | whoever may read the fixture (`competition.read_readiness`)                                                                                                                                                                                                                                                                                                 |
| POST/GET | `/fixtures/{id}/disputes`, `/disputes/{id}`                       | submit: the captain of a competing entry (team role) or league administration, inside the protest window; read: league administration, support, the submitting captain                                                                                                                                                                                      |
| POST     | `/disputes/{id}/decide`                                           | league administration: review, decide (decision, publication consequence, reason) or withdraw                                                                                                                                                                                                                                                               |
| POST/GET | `/incidents[/{id}]`, PATCH `/incidents/{id}`                      | report: league management, or an official for a fixture they accepted; read and review/close: league management (`competition.read_discipline`, `competition.manage_discipline`); others NOT_FOUND                                                                                                                                                          |
| POST/GET | `/disciplinary-decisions[/{id}]`, POST `…/{id}/overturn`          | league management; the subject (or a guardian with `view`) reads decisions about them                                                                                                                                                                                                                                                                       |
| POST/GET | `/suspensions[/{id}]`, PATCH `/suspensions/{id}`                  | propose, approve (`proposed → active`), overturn: league management; read: league management, the subject or a guardian with `view`                                                                                                                                                                                                                         |
| POST/GET | `/appeals[/{id}]`, POST `/appeals/{id}/decide`                    | submit: the subject, a guardian with `register`, the dispute's submitter or a competing captain, or league management; decide: league management                                                                                                                                                                                                            |

Every consequential POST/PATCH is `@Idempotent()` and zod-validated; every write runs in
`UnitOfWork.run` with an audit record and outbox follow-ups. Creating or renewing an entry and every
fixture command create an `operation` (`GET /v1/operations/{id}`). A fixture command and its
scheduling event commit in one transaction (the scheduling command joins it; `UnitOfWork.run` is
reentrant): a refused scheduling step (for example a conflict) is recorded, so the fixture stays
`unscheduled` and the operation `failed` with the reason, and any other failure rolls the whole
command back, so no event exists that its fixture does not reference (§4.7 invariant 12, §4.9,
§4.12). The `scheduling.event_changed` follow-up applies the event's current state, read inside its
own transaction, never the payload's change: late or reordered deliveries converge on the latest
state and never relink a canceled event (§4.12, §4.6; **Verified**,
`__tests__/fixture-sync-order.spec.ts`).

## Ports (`ports.ts`, provided by `CompetitionModule`)

- `TEAM_ENTRY_QUERY_PORT` → `findTeamEntry`, `listSeasonEntries`, `entriesOfPerson(at)` (ids and
  readiness facts only).
- `ROSTER_PORT` → `effectiveRoster(organizationId, teamEntryId, at)` (SPK-COMP-005: the roster as
  it was at an instant) and `addRegisteredMember(trx, …)` (SPK-AT-002: enrollment's confirmation of
  a paid `join_team` registration adds the active membership, source `registration` from migration
  `0453`, in the caller's transaction after re-evaluating eligibility; idempotent; **Verified**
  `apps/api/src/__tests__/journeys/spk-at-002.spec.ts`).
- Closure impact contributor `competition.rostered_players` (SPK-SCHED-009, SPK-AT-009): rostered
  players of committed teams, effective at the event start, are the preview's customers.
- `FIXTURE_PORT` → `findFixture`, `listSeasonFixtures`, `fixturesOfEntry`, `recordOutcome`
  (results in part 2 move a fixture to played/forfeit/abandoned inside the caller's transaction).
- `ELIGIBILITY_PORT` → `evaluatePlayer(organizationId, teamEntryId, personId, at, options)`:
  explainable reasons (code, severity blocking/warning/info/unknown, source record, responsible
  role, required action — SPK-READY-003). Unknown evidence is never a pass (SPK-READY-002).
  A suspension reason never embeds the suspension's basis text; with `options.restricted` (every
  roster path whose reasons reach a captain, player or guardian) restricted source ids
  (suspension, dispute, incident, audit record) are null and age and multi-team reasons carry
  the limit and reference date, never the computed age or other-team count (SPK-CAP-002,
  SPK-DISC-004).
- `SUSPENSION_CHECK_PORT` (interface + `SUSPENSION_CHECK_IMPL` token): answered by this module's
  own `DisciplineService` (part 2); an implementation registered elsewhere under
  `SUSPENSION_CHECK_IMPL` takes precedence (none is registered today). Resolved by the small
  resolver in `competition.module.ts`, not through `lazyPort`, so the normal case logs no warning.
- `READINESS_CHECK_REGISTRY` → `registerCheck(name, fn)` / `checks()`: other modules register
  fixture readiness checks (today only workforce, with `workforce.required_officials`; finance and
  facilities register none); `ReadinessService` runs them on every read. A
  check named `workforce.*` replaces the "officials unknown" verdict; a check that throws is
  reported as `unknown` evidence, never as a pass.
- Part 2 consumer ports (`competition-matches.ports.ts`), resolved lazily; each owning module
  registers under the `*_IMPL` token, and a deterministic default answers only when that module is
  not part of the application (competition-only tests): `ASSIGNMENT_CHECK_PORT` (workforce: is the
  person an accepted official for the fixture — default no, so only league administration submits
  results), `FORMS_CHECK_PORT` (enrollment over catalog: the season's registration offering's
  required forms against the rostered participants' acknowledgments — default `unknown`),
  `FINANCIAL_CONDITIONS_PORT` (finance: open obligations of the competing team entries, reported
  `unknown` while POL-017/DEC-056 are pending — default `unknown`), `CHANGE_NOTICE_CHECK_PORT`
  (communications: delivery of the notice that describes the fixture's current time — default
  `unknown`). **Verified** in the assembled application
  (`apps/api/src/__tests__/cross-module-ports.spec.ts`).
- Exported services for other modules: `ResultsService`, `StandingsService`, `BracketsService`,
  `DisciplineService`, `DisputesService`, `FixtureGenerationService`, `ReadinessService`,
  `FixtureObligationsService`, plus the pure `computeStandings`, `generateFixtures`, `roundRobin`
  and `validateCompleteness`.
- Part 2 fixtures: `testing/competition-matches-fixtures.ts` (`createResultRevisionFixture`,
  `createSuspensionFixture`, `createBracketNodeFixture`), written directly; the constraints apply.
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
communications re-evaluate), `competition.availability_responded`. Part 2
(`competition-matches.events.ts`): `competition.result_submitted`, `competition.result_returned`,
`competition.result_published` (with the superseded revision, the standings projection, and for a
reviewed correction the review task and the affected bracket nodes and games),
`competition.result_correction_review_required`, `competition.standings_recomputed`,
`competition.bracket_node_created/published`, `competition.fixture_specification_created`,
`competition.fixtures_generated`, `competition.dispute_submitted/changed`,
`competition.incident_reported/changed` (never the narrative),
`competition.disciplinary_decision_issued/overturned`, `competition.suspension_changed`
(eligibility and readiness re-evaluate), `competition.appeal_submitted/changed`. Payloads carry
identifiers only.

## Behaviour notes — verified

- Eligibility (`services/eligibility.service.ts`) evaluates, for the membership being considered
  (active, guest or substitute — a guest label bypasses nothing, SPK-CAP-004): person status, entry
  and season state, the division age band at the rule set's reference date computed from the
  identity date of birth (§4.5), roster limits (regular places; guests have their own concurrent
  limit), substitutes/guests allowed, required league approval, multi-team restrictions
  (entries per season, same division, cross division), suspensions through the port
  (SPK-AT-013) and, for a fixture, the opposing roster and overlapping scheduled fixtures.
- Rosters (SPK-COMP-005, `services/roster.service.ts`): an addition or removal takes effect now or
  at a later instant. A change dated before now rewrites the roster of matches already played, so
  a captain cannot make one (`VALIDATION_FAILED`, `retroactive_roster_change`); league staff can,
  only with the command `reason`, and the audit records it as a correction (`retroactive: true`,
  `recordedAt`, `correctionReason`). A completed or archived season takes no roster change at all
  (`INVALID_TRANSITION`): its rosters are history. An addition is evaluated over the whole interval
  its open-ended row covers: the roster and guest limits at the busiest instant from its effective
  instant on (future-dated rows count), the multi-team restrictions against every other membership
  effective at any instant from then on, and suspensions at its effective instant and, when that is
  in the past, now. Additions of one person within a season are serialized by a transaction-scoped
  advisory lock, so two captains adding the same player to two entries at once cannot both pass the
  multi-team restrictions (tested on PostgreSQL). Removing a player from a withdrawn entry, effective
  now or later, stays allowed.
- Renewal (SPK-AT-003, SPK-CAP-005) creates a new entry for the same continuing team, prefilled from
  the prior entry and returning prior players as suggestions; the prior season's rows are not
  touched (tested byte-identical) and nothing is charged.
- Captains see display names and readiness codes only; dates of birth, contacts, payment
  instruments and notes never appear in competition responses (SPK-CAP-002). Customer-facing
  eligibility reasons (explain, invitation and roster 422 details, join requests) carry codes,
  limits and reference dates, never suspension bases, restricted record ids or computed ages.
  Ordinary teammates and guardians (viewers who cannot manage the entry) read the roster in the
  workspace and `GET /team-entries/{id}/roster` (also at a past `at`) without removal reasons and
  with eligibility indicators only on their own membership (SPK-CAP-002, SPK-DISC-004,
  `rosters.spec.ts`); captains, co-captains and staff keep the full member.
- Pending invitations expire lazily on an acceptance attempt by the token holder.

## Behaviour notes, part 2 — verified

- **Results** (`services/results.service.ts`): one revision in progress per fixture; a bye has no
  result. Publication runs in one transaction with an `operation`: supersede the official revision
  (if any), make the revision official, move the fixture through its machine
  (played/forfeit/abandoned), serve match-count suspensions (only for a match that took place, and
  only suspensions approved before kickoff), propose the rule set's card suspensions, progress the
  bracket (the first result of a playoff game with a winner, or the correction that decides a game
  whose official result had none: winner recorded, empty fed slots filled), recompute the league
  standings (playoff games never count), audit and outbox. A bracket node links only a fixture
  without a published result: a published league result counts in the standings, so linking it is
  refused (`fixture_result_published`); create the playoff fixture for the node.
- **Corrections** (SPK-RESULT-004, SPK-AT-014): a correction is a new revision; the superseded row
  keeps its scores, actor, reason and publication instant. When it would touch published history —
  a playoff game whose node or downstream nodes are published, or a league game whose corrected
  standings would change a seed a published node draws from — nothing is rewritten: a
  `competition.result_correction_review` exception (league manager queue) is raised and the
  correction stays submitted. League management decides: publishing with `reviewExceptionId` (the
  open task of that correction) applies the correction and resolves the task, leaving the published
  bracket as history and naming the affected nodes and games in the event; returning the correction
  resolves the task too. A correction that changes the winner or loser of a playoff game also waits
  for review when a node fed by the game has recorded a winner or has its fixture (its sides were set
  from the old outcome). Otherwise — the game's node and the nodes it feeds are unpublished and
  nobody acts on them yet — the correction is published and revises the progression: the node's
  winner and each fed slot that still holds the previous entry take the new outcome, audited as
  `progress_revised` with the previous and next outcome.
- **Standings** (`matches/standings.calculator.ts`): points, forfeit scores and points from the
  season's rule-set version; cancellations, postponements, disputes and abandonments below the
  rule set's minimum do not count; tiebreakers in rule-set order, each step explained
  (`resolved`, `partially_resolved`, `not_separating`, `unresolved`); a draw of lots or play-off is
  reported unresolved, never simulated.
- **Fixture generation** (`matches/fixture-generator.ts`): circle-method round robin repeated per
  opponent frequency with alternating venues, one bye per team per cycle for odd counts; greedy
  placement over seeded candidate orderings into slots (allowed start times × dates outside
  blackouts × required resources) under hard constraints (a resource holds one game at a time,
  its setup and cleanup turnover included — the resources' scheduling defaults, as publication
  counts them; no team overlap, minimum rest, round order, every preference marked `hard`); soft
  preferences are scored and reported separately (SPK-FIX-003). Outcomes are honest (SPK-FIX-004):
  `proven_optimal` only when the penalty is zero, `proven_infeasible` only for a counting proof
  (capacity — non-overlapping occupied intervals per resource, so start times closer than a match
  are flexibility, not capacity — playable days, hard availability), otherwise `feasible` or
  `no_proposal_within_limit` ("infeasibility is not proven"). A proposal that breaks a hard
  constraint is kept on the run for explanation only: it creates no fixtures and opens no draft. A
  real (non-dry) run holds the division row while it checks for existing fixtures and creates its
  own, so two specifications of one division generated at once never create two fixture sets
  (tested on PostgreSQL). The completeness validator reports missing, duplicate and excess games,
  unscheduled games, opponent frequency, invalid byes and playoff requirements with remaining
  obligations (SPK-FIX-002). SPK-AT-010 is verified with five teams in a double round robin: 20
  games, 10 bye records (two per team, one per cycle), complete.
- **Readiness** (`services/readiness.service.ts`, SPK-READY-001..004): derived on every read from
  scheduling (published event, resource status, active closures), part 1 (entry approval, effective
  rosters, eligibility with suspensions), the registered checks (officials), the forms, finance and
  change-notice ports, proposed suspensions and pending disputes. Each issue carries severity
  `blocking/warning/info/unknown`, reason, source record, responsible role, required action, last
  evaluation and deadline; the verdict is `blocked` > `unknown` > `warning` > `ready`. A missing
  RSVP is `info`; unknown evidence is never a pass. Customers see suspension, dispute, incident and
  audit sources without their record ids (SPK-DISC-004). Scheduling is the authority for the time:
  when the event's instants differ from the fixture's copy (the `scheduling.event_changed`
  follow-up has not run yet), readiness raises `schedule_out_of_sync` (unknown) and evaluates
  rosters, eligibility, deadlines and change notices at the event's time (SPK-READY-002/004,
  `readiness.spec.ts`).
- **Discipline** (SPK-DISC-001..005): incidents and narratives are readable by league management
  only (never in result views, events or audit details); a suspension restricts eligibility only
  once approved and only within its scope; the rule set's card rules propose suspensions (red card:
  `redCardSuspensionMatches`; reaching a multiple of `yellowAccumulationThreshold` in the season:
  `yellowAccumulationSuspensionMatches`, once per threshold crossing in the season, so a correction
  of an earlier fixture never proposes a crossing again), once per person, fixture and rule;
  overturning a decision ends the suspensions it created; appeals mark the appealed suspension (or
  the decision's suspensions) pending, granted or denied.
- **Disputes** (SPK-RESULT-005): the window is the rule set's `protestDeadlineHours` from the
  official publication (else the scheduled end); a dispute never changes a result by itself — a
  `correction_required` consequence is carried out by a correction revision citing the dispute.

## Stage 3 (CMP-01 … CMP-15)

Labels follow §6.7: **verified** = implemented and covered by the named tests (PGlite and
PostgreSQL); **proposed** = a default chosen here pending an operator decision; **pending** = not
built, waiting on a decision or another module.

### Migrations (verified, `__tests__/stage3-schema.spec.ts` proves each rejection in the database)

| Migration                                | What it adds                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0454_competition_team_invitation_reads` | `team_invitations_declined_fact` (`declined` ⇔ `declined_at`); recipient, contact and pending-expiry indexes (CMP-03, CMP-07)                                                                                                                                                                                         |
| `0455_competition_fixture_venue`         | `fixtures.venue_facility_id` (composite FK to facilities), `venue` jsonb, `venue_event_revision`; checks: venue and facility present together, the JSON names the same facility, revision ≥ 1 (CMP-04)                                                                                                                |
| `0456_competition_import_source`         | `source in ('staff','import')` on seasons, teams and team entries (default `staff`); roster `source` gains `import` (CMP-09)                                                                                                                                                                                          |
| `0457_competition_shootout_winner`       | `result_revisions.shootout_winner_entry_id` (composite FK), check: only a completed draw names one; trigger `result_revisions_shootout_side_guard`: the winner is a fixture side; the history guard also freezes it once official (CMP-10)                                                                            |
| `0458_competition_availability_requests` | `availability_requests` (append-only, `forbid_mutation`; message ≤ 500; recipient count ≥ 0; composite FKs); trigger: the entry is a side of the fixture (CMP-14)                                                                                                                                                     |
| `0459_competition_tournament_pools`      | `team_entries (organization_id, id, season_id, division_id)` key; `pools` (unique name per division) and `pool_entries` (composite FKs to the pool's season and division and to an entry of that same season and division; one pool per entry per division; seed > 0); compressed-play specification columns (CMP-15) |
| `0460_competition_staff_list_indexes`    | `(organization_id, created_at desc, id desc)` indexes for the dispute, appeal and disciplinary decision lists (CMP-05)                                                                                                                                                                                                |

### Endpoints added or changed (verified)

| Method   | Path                                                                                                                                                                       | Who (action)                                                                                                                                                                                                                                          | Tests                                                 |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| GET      | `/seasons/{id}/readiness?from&to`                                                                                                                                          | league staff (`competition.read_readiness`); ≤ 100 fixtures else `VALIDATION_FAILED TOO_MANY_FIXTURES`; counts only, unknown stays unknown                                                                                                            | `team-workspace.spec.ts` (CMP-01)                     |
| GET      | `/seasons/{id}/fixtures`, `/team-entries`, `/team-entries/{id}`, bracket nodes, solver runs                                                                                | rows carry team names (null for a bye), one name query per page                                                                                                                                                                                       | `team-workspace.spec.ts`, `brackets-pools.spec.ts`    |
| GET      | `/me/team-entries?status`, `/me/fixtures?from&to` (≤ 120 days)                                                                                                             | customers: themselves and the people they hold `view` over (`customerSubjects`, expanded with `personIdsResolvingTo`)                                                                                                                                 | `team-workspace.spec.ts` (CMP-02)                     |
| GET      | `/team-entries/{id}`                                                                                                                                                       | gains `viewer { roles, actingAsCaptain, availableActions }`; pending invitation/join-request lists are `null` when hidden, `[]` when empty                                                                                                            | `team-workspace.spec.ts` (CMP-02)                     |
| GET      | `/me/team-invitations?status&cursor`, `/team-invitations/{id}`                                                                                                             | recipient (by person or verified contact), a guardian with `register`, captains, co-captains, league staff; else protected NOT_FOUND; never the token                                                                                                 | `invitations-roles.spec.ts` (CMP-03)                  |
| POST     | `/team-invitations/{id}/decline`                                                                                                                                           | recipient or a guardian with `register` (`competition.decline_team_invitation`); `@RecordAuthority('roster')`                                                                                                                                         | `invitations-roles.spec.ts` (CMP-03)                  |
| GET      | `/fixtures/{id}`                                                                                                                                                           | gains `venue`, `rosterStatus`, `responses` (viewer and people they hold `register` over); `myResponse` deprecated                                                                                                                                     | `team-workspace.spec.ts` (CMP-04)                     |
| POST     | `/fixtures/{id}/availability`                                                                                                                                              | enforces `expectedRevision` (STALE_REVISION); refused from kickoff (`INVALID_TRANSITION AVAILABILITY_CLOSED`)                                                                                                                                         | `team-workspace.spec.ts` (CMP-04)                     |
| GET      | `/disputes`, `/appeals`, `/disciplinary-decisions`, `/divisions/{id}/fixture-specifications`, `/fixture-specifications/{id}/solver-runs`, `/seasons/{id}/result-revisions` | staff holding the single read's action; keyset `created_at desc, id desc`                                                                                                                                                                             | `league-operations.spec.ts` (CMP-05)                  |
| GET      | `/fixtures/{id}/match-sheet`                                                                                                                                               | league staff; an official only with an accepted assignment (`ASSIGNMENT_CHECK_PORT`); a captain of either side sees names and numbers only; else protected NOT_FOUND                                                                                  | `team-workspace.spec.ts` (CMP-06)                     |
| POST     | `/bracket-nodes/{id}/seed-from-standings`                                                                                                                                  | league administration (`competition.manage_brackets`), `@RecordAuthority('season')`; only final standings (`STANDINGS_NOT_FINAL`), an unresolved tie names the tied entries (`UNRESOLVED_TIE`); division or pool sources                              | `brackets-pools.spec.ts` (CMP-10, CMP-15)             |
| POST     | `/fixtures/{id}/results`                                                                                                                                                   | `shootoutWinnerEntryId` for a drawn bracket game under rule set `tiebreak.playoff: shootout` (else `SHOOTOUT_NOT_ALLOWED`); a played result before kickoff is `INVALID_TRANSITION FIXTURE_NOT_STARTED` (forfeit, canceled and postponed are recorded) | `brackets-pools.spec.ts`, `league-operations.spec.ts` |
| POST     | `/disputes/{id}/withdraw`                                                                                                                                                  | the submitter or a captain of the submitting entry (`competition.withdraw_dispute`), `@RecordAuthority('result')`                                                                                                                                     | `league-operations.spec.ts` (CMP-12)                  |
| GET      | `/seasons/{id}/standings`                                                                                                                                                  | a divided season without `divisionId` is `VALIDATION_FAILED DIVISION_REQUIRED` with the division ids                                                                                                                                                  | `league-operations.spec.ts` (CMP-12)                  |
| PATCH    | `/fixture-specifications/{id}`                                                                                                                                             | league administration, `@RecordAuthority('season')`, `expectedRevision`; refused while a generation from it sits in an open scheduling draft (`SPECIFICATION_IN_USE`)                                                                                 | `league-operations.spec.ts` (CMP-12)                  |
| POST     | `/team-entries/{id}/roles/handover`                                                                                                                                        | the current captain or league staff (`competition.handover_team_role`), `@RecordAuthority('roster')`; the two role rows end and start at one instant                                                                                                  | `invitations-roles.spec.ts` (CMP-13)                  |
| POST/GET | `/fixtures/{id}/availability-requests`                                                                                                                                     | a captain of the entry (a co-captain only when the rule set lets one act as captain) or league staff; before kickoff; `@NoRecordAuthority('Not a §5.3 record category')`                                                                              | `team-workspace.spec.ts` (CMP-14)                     |
| POST/GET | `/divisions/{id}/pools`, `/pools/{id}`, `/pools/{id}/entries`, `/pools/{id}/entries/{teamEntryId}/remove`, `/pools/{id}/standings`                                         | league administration (`competition.manage_pools`), `@RecordAuthority('season')`; creation and placement need the `tournaments` capability                                                                                                            | `brackets-pools.spec.ts` (CMP-15)                     |

### Behaviour (verified)

- **CMP-01** `TEAM_ENTRY_QUERY_PORT` (IF-15) gains `seasonForOffering` and `roleHolders` (roles
  effective at an instant, with or without a roster row; reflects a handover at once).
- **CMP-03 / CMP-07** A declined invitation can no longer be accepted. The expiry sweep claims due
  invitations with `SKIP LOCKED`, one transaction each, through `TeamInvitationMachine 'expire'`,
  audited with the system-only action `competition.expire_team_invitation` and announced as
  `competition.team_invitation_resolved` (`expired`, `personId: null`); the lazy expiry on
  acceptance announces the same fact; a replayed run changes nothing. Expiry durations unchanged.
- **CMP-04** The venue copy follows the fixture's current scheduling event and is replaced only by
  a newer event revision; an unlinked event's venue is dropped; the copy never bumps the fixture
  revision. Fixtures created before `0455` read `venue: null` until their event changes.
- **CMP-08** `competition.follow_person_merge` rewrites nothing; when the survivor and the merged
  person both hold an effective roster row or open role on one entry it raises
  `competition.merged_roster_duplicate` once per merge (league manager queue). Eligibility and
  `SUSPENSION_CHECK_PORT` evaluate a person through `personIdsResolvingTo`, so a suspension of the
  merged person binds the survivor (`person-merge.spec.ts`).
- **CMP-09** `CompetitionImportService` (exported, IF-40, in-process only): `importSeason`,
  `importTeam`, `importTeamEntry`, `importRosterMembership` for the import principal of one batch
  (`assertImportPrincipal`), joining the caller's unit of work; create-if-absent with
  `id = recordId`, `source = 'import'`, audited with the import actor; different content is
  `RESOURCE_CONFLICT IMPORT_CONTENT_MISMATCH`. An approved entry goes `applied → approved` with the
  snapshot's approval date; withdrawn and rejected entries are refused
  (`IMPORT_STATUS_NOT_IMPORTABLE`, they stay staged history); roster rows keep their effective
  dates (an ended one is imported removed). Imports publish no domain events
  (`competition-import.spec.ts`).
- **CMP-11** Competition no longer selects kernel tables: `OperationalExceptions.get/list` (IF-29)
  replace `operational_exceptions` reads and the reviewing league manager resolves the review task
  as the audited actor (`exceptions.manage_own_queue`); `FacilityDirectory` (IF-03) replaces
  `facilities` reads; `AuditReader.forTarget` (IF-44) replaces `audit_records` reads
  (`kernel-reads.spec.ts`, `result-corrections.spec.ts`).
- **CMP-12** An official correction that removes the card behind a `proposed` rule-set suspension
  overturns it in the same transaction (reason `card removed by correction`); an `active` one stays
  and raises `competition.suspension_card_removed` (league manager queue) once.
- **CMP-13** With rule set `roster.jerseyNumbers { min, max }` roster additions (and imports)
  outside it are `VALIDATION_FAILED JERSEY_OUT_OF_RANGE`; without it only per-entry uniqueness
  applies. A handover needs the new holder on the active roster (`NOT_ON_ROSTER`), adult for the
  captaincy (proposed default, `CAPTAIN_MUST_BE_ADULT`) and eligible; outbox
  `competition.team_role_changed` carries `fromPersonId`, `toPersonId`, `effectiveAt`.
- **CMP-14** Recipients are the entry's roster players at kickoff without an answer; a later
  request is the reminder (audit `reminder: true`) and reaches only those still without one;
  `competition.availability_requested` (IF-45) names them. Without communications nothing is sent;
  the request is recorded.
- **CMP-15** Compressed play: `maxGamesPerTeamPerDay` and `officialsPerGame` are optional on
  specifications (existing ones unchanged); when set the generator keeps each team within the
  daily cap and the minimum rest and reports per facility-local day the games, peak concurrent
  games and the official assignments they need (`explanation.dailyDemand`). Official turnaround and
  daily limits apply at assignment in workforce (WRK-06).

### Behind a capability switch

- `tournaments` (DEC-016 applicability, DEC-078): creating a pool and placing an entry in a pool
  are refused with `ACCESS_DENIED details.code CAPABILITY_DISABLED` while the organization has not
  enabled it (default off; changed only by an authorized administrator through the kernel
  capability commands, audited). Removing an entry, reading pools and pool standings, and seeding
  brackets from existing pools are never gated (unwinding and reads). **Verified**
  (`brackets-pools.spec.ts`). Seeding from division standings and shootout winners (CMP-10) are
  for every competition and not gated.

## Policy defaults (proposed, pending operator decisions §6.6)

- Rule-set defaults per format (`proposedRuleSetContent`): DEC-002 / POL-026 / POL-032. They are
  configuration a league manager starts from; evaluation always reads the season's rule-set version.
- A co-captain does not satisfy captain checks (`coCaptainMayActAsCaptain: false`).
- A team captain must be an adult (pending the guardian/child-account policy).
- Only league staff (league manager, general manager, system administrator) may date a roster
  change before now, with a reason (SPK-COMP-005 keeps effective dates; who may correct a past
  roster is not specified).
- Invitation lifetime 7 days (`TEAM_INVITATION_DEFAULT_HOURS`); the raw token is returned once to
  the inviter because no messaging provider is selected (§5.2).
- The `tentative` RSVP state is accepted (DEC-064 pending).
- Result publication authority: `league_manager` plus the rule set's `approveRoles`; review of a
  correction against published history: league manager or general manager (DEC-065).
- Discipline managers: league manager and general manager; rule-set card suspensions are scoped
  to the competition of the card (DEC-010).
- Fair-play tiebreak weights (`FAIR_PLAY_POINTS`: yellow 1, second yellow 3, red 3; DEC-002).
- Remaining fixture obligations are due 7 days after the publication, capped at the season end
  (`UNSCHEDULED_FIXTURE_DEADLINE_DAYS`; SPK-AT-010 example, DEC-002).
- Solver search defaults (`DEFAULT_SEARCH_SETTINGS`: 40 candidates, 2 s, seed 1); the request may
  override them and the run records what was used.
- Coach or family convenience (`approved_convenience`) is accepted only with an approval
  reference; which preferences are hard is the specification's choice (DEC-049).
- Stage 3: availability answers and availability requests close at kickoff until a rule set
  defines a cutoff (DEC-002); a co-captain requests availability only under
  `coCaptainMayActAsCaptain`; a drawn playoff game names a shootout winner only under rule set
  `tiebreak.playoff: shootout` (absent: no winner, the bracket waits, DEC-002); no jersey range is
  assumed (DEC-002); the invitation sweep's interval (60 s) and failure owner are technical values,
  not policy.

## Known gaps

- **Pending (other modules):** CMP-02 lists and CMP-08 merge resolution call identity's
  `PERSON_DIRECTORY_PORT.personIdsResolvingTo` and `subjectsWithPermission` (ID-01/ID-04). On a
  branch without them the port's declared default refuses (`declaredNotImplemented`), so the
  eligibility, suspension and "my teams" paths need the identity work merged; the competition
  suite passes with it (PGlite and PostgreSQL). CMP-06 officials depend on workforce's
  `ASSIGNMENT_CHECK_IMPL` (DEC-011 governs assignment rules). CMP-14 delivery depends on
  communications consuming `competition.availability_requested`.
- **Pending (decisions):** DEC-078 (tournament applicability) and DEC-016 decide whether the
  `tournaments` switch is turned on; DEC-002 rule-set content (tiebreaks, compressed play, jersey
  ranges, availability cutoff); DEC-011 official limits.
- `team_entries.eligibility_status` is recorded (`pending` by default) but no command moves it yet;
  the entry-level evaluation belongs with placement (§3.6).
- No transfer command (a transfer is a removal plus an addition with effective dates). Jersey
  numbers are validated on additions; there is no roster "update" command.
- Brackets: no bracket generator from the specification's playoff structure (reported as a
  remaining obligation); a published node cannot be edited or reseeded, so after a reviewed
  correction the league manager adjusts the bracket by new nodes.
- A correction that changes the classification leaves the fixture in its first outcome state (the
  fixture machine's outcomes are terminal); the result revision is authoritative. A `canceled` or
  `postponed` classification records the fact; cancelling or postponing the game itself remains a
  fixture command.
- An open team obligation keeps the finance check `unknown` (never a pass or a block) until the
  participation policy for team balances is approved (POL-017, DEC-056). A fixture whose event was
  canceled (postponed, unlinked) reports the change notice as `unknown`.
- A decided dispute's consequence is not executed automatically (a correction revision carries it
  out).
- The generator is a seeded greedy search, not an exact solver, so `proven_optimal` is claimed only
  at zero penalty. It treats each required resource independently: a specification naming both a
  pitch and one of its halves could place two games on shared ground, which publication validation
  then refuses.
- Evidence is a list of references; uploads are not stored here.
- Integration notes: `docs/api/openapi.json` is regenerated by the integrator (`pnpm openapi`)
  after the stage-3 branches merge; the workforce replacement-readiness journey submits a result
  and must advance its clock to kickoff (CMP-12).
