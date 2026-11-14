# SDE hand-off: Track C (PA-10 team waiting list, PA-06 public and lobby views)

Feature `glass-demo-amendments`. Status words follow §6.7: **Verified**, **Proposed**,
**Pending decision**. Both requirements stay **Proposed**; their open values stay
**Pending decision** (DEC-104, DEC-100).

## 1. What was built

### PA-10, SPK-COMP-006, capability `team_waitlist`

- Database: `packages/db/migrations/0467_competition_team_waiting.sql`;
  `packages/db/src/schema/competition.ts`.
- Contracts: `packages/contracts/src/api/competition-waitlist.ts` (commands, lists, paths);
  `competition.ts` gains the `waiting` status, `TeamEntry.waitingSince` and `waitingDivisionId`,
  `TeamEntryPlaceOffer`, `TeamEntryWaiting` and `TeamEntryWorkspace.waiting`.
- API (competition): `competition.state-machines.ts` (events `wait`, `accept_place`; the offer
  machine), `competition.actions.ts`, `competition.events.ts`, `competition.settings.ts`,
  `competition.policy.ts`, `competition-waitlist.queries.ts`, `services/team-waitlist.service.ts`,
  `controllers/team-waitlist.controller.ts`, and changes in `services/team-entries.service.ts`
  (automatic wait on a placement into a full division, closing an open offer on withdrawal or
  rejection, the workspace's `waiting`, the refusal of an obligation for a waiting entry),
  `services/seasons.service.ts` (a capacity cannot drop below placed entries plus open offers),
  `services/my-competition.service.ts`, `competition.module.ts`.
- Staff: `apps/staff/src/features/competition/WaitingListPanel.tsx`,
  `screens/teams/TeamEntryReviewScreen.tsx`, `screens/teams/TeamsScreen.tsx`,
  `features/competition/labels.ts`.
- Mobile: `apps/mobile/src/features/teams/TeamWaiting.tsx`,
  `screens/teams/TeamWorkspaceScreen.tsx`, `screens/teams/TeamEntryScreen.tsx`,
  `features/teams/status.ts`.
- Tests: `apps/api/src/modules/competition/__tests__/team-waitlist.spec.ts`,
  `team-waitlist-schema.spec.ts`, `team-waitlist-concurrency.spec.ts`; the state machine spec;
  `apps/api/src/__tests__/journeys/facility-league.spec.ts` (gap kept with the switch off, waiting
  path with it on); `apps/staff/src/screens/teams/__tests__/TeamWaitingList.test.tsx`;
  `apps/mobile/src/screens/teams/__tests__/TeamWaiting.test.tsx`.

### PA-06, SPK-SCHED-010, capability `public_schedule`

- Database: `0305_scheduling_facility_public_views.sql`, `0470_competition_public_visibility.sql`;
  schema files of both modules.
- Contracts: `packages/contracts/src/api/scheduling-public.ts`, `competition-public.ts`.
- Kernel: `public_views` added to `DEFAULT_RATE_LIMITS` (`kernel/http/rate-limit.ts`) and to
  `RATE_LIMIT_NAMES` (`kernel/config.ts`).
- API (scheduling): `scheduling/public/public-access.ts`, `public-schedule.service.ts`,
  `public-schedule.controller.ts`; actions, event, module wiring.
- API (competition): `competition/public/public-competition.service.ts`,
  `public-competition.controller.ts`; actions, event, module wiring; `seasons.service.ts` issues a
  public code when a season is created.
- Staff: `apps/staff/src/screens/public/` (`routes.tsx`, `PublicFrame.tsx`, `usePublicView.ts`,
  `PublicScheduleScreen.tsx`, `PublicSeasonScreen.tsx`, `LobbyScreen.tsx`, `public.css`);
  `features/competition/PublicationPanel.tsx` on `screens/leagues/CompetitionScreen.tsx`;
  `screens/schedule/PublicScheduleSettingsScreen.tsx` in `screens/schedule/ScheduleArea.tsx`.
- Mobile: `apps/mobile/src/screens/public/PublicViews.tsx`, `app/public/schedule.tsx`,
  `app/public/standings.tsx`, a link card on `screens/discover/DiscoverScreen.tsx`.
- Tests: `apps/api/src/modules/scheduling/__tests__/public-schedule.spec.ts`,
  `apps/api/src/modules/competition/__tests__/public-competition.spec.ts`, the kernel rate limit
  spec, the league journey; `apps/staff/src/screens/public/__tests__/PublicScreens.test.tsx`;
  `apps/mobile/src/screens/public/__tests__/PublicViews.test.tsx`.

## 2. Deviations from the architect contract, and why

1. **Base commit.** The worktree was created at `main` (51253046), which has neither the
   capability ids nor `.10x/`. The branch was fast-forwarded to the feature branch of pull request 21
   (95921687) before any work; nothing else was merged.
2. **A public directory read was added**: `GET /v1/public/{organization}/directory` lists the
   facilities whose public schedule is enabled and the public competitions, by name and public
   code. The customer app starts from the organization slug alone and needs it to link to
   "today's schedule" and "public standings". It lists only what the operator made public, under
   the same capability, rate limit and "not available" answer. Consequence to review: a public
   code is then discoverable by anyone who knows the slug, so rotating a schedule code stops old
   links but does not hide an enabled view. ADR-005 says "no listing of private things"; this
   lists public things. **Pending decision** for the architect and security review.
3. **Offering names are not shown on the public schedule.** A class reads "Class". Catalog
   sessions point at scheduling events whose titles staff typed; the title of an event is never
   shown. The registry for system-generated titles exists (`PublicScheduleTitles`), competition
   uses it, and catalog (another track's module) must register a contributor for the events of
   its published offerings.
4. **One season payload** carries fixtures, results, standings and bracket
   (`/public/{organization}/seasons/{code}`); the staff web pages split it into four routes.
5. **Waiting for a season** (no division named) is allowed only when every division of the season
   is full; the entry then waits on a season-wide list and an offer names the division.
6. **`GET /me/team-entries` lists waiting entries** by default, so a captain can open the team.
   Every other place that enumerates `applied`, `approved` still excludes waiting entries
   (fixtures, fixture generation, standings, pools, rosters, eligibility, division counts,
   player balance, enrollment's registration evaluation, reporting's approved-entry counts).
7. **The capacity refusal** details keep `capacity` and `occupied`; `heldByOffers` is added only
   when an open offer holds a place, so the answer without the waiting list is unchanged.
8. **Migration 0467 to 0469 and 0470 to 0479** were reserved; used: 0467 and 0470 (competition),
   0305 (scheduling).
9. **A bracket match has no name** in the public shape (round and slot only): node names are
   typed by staff.
10. **A "not available" answer is `no-store`**; only successful public answers are cacheable.

## 3. To register at integration

- `apps/staff/src/App.tsx`: ONLY the public and lobby routes were added, outside
  `RequireSession` (`{publicRoutes()}` after `/sign-in`). No navigation entry was added: the
  "Public schedule" section is a sub-navigation item inside the Schedule area
  (`ScheduleArea.tsx`), and "Public pages" is a panel of the competition screen.
- Event handler manifest (`apps/api/src/__tests__/event-handler-manifest.json`): one line added,
  `competition.team_place_offer_expiry_due` → `competition.expire_team_place_offer`. If another
  track also edited the file, keep both lines (`UPDATE_HANDLER_MANIFEST=1` adds missing names).
- Generated files were regenerated and committed on this branch and must be regenerated again
  after the merge: `docs/api/openapi.json`, `packages/api-client/src/generated/paths.ts`,
  `docs/package-a/permission-matrix.generated.md`, `packages/db/src/schema/index.ts`,
  `packages/contracts/src/api/index.ts`.
- Shared test fixtures gained the new required fields: `teamEntry()` (`waitingSince`,
  `waitingDivisionId`) and `workspace()` (`waiting`) in
  `apps/staff/src/features/competition/__tests__/fixtures.ts` and
  `apps/mobile/src/features/teams/testing/fixtures.ts`. A track that builds its own `TeamEntry`
  or `TeamEntryWorkspace` literal needs them.
- The demo dataset (Track G) can use: `POST /team-entries/{id}/wait`, `.../place-offers`,
  `POST /competitions/{id}/publish`, `POST /facilities/{id}/public-schedule-view/enable`.
- Catalog (see deviation 3): register a `PublicScheduleTitles` contributor.
- Communications: `competition.team_place_offered` and `competition.team_place_offer_resolved`
  have no consumer; a captain is not notified of an offer.

## 4. Technical debt created

- The waiting position is computed by reading the season's waiting rows; fine for the tens of
  teams a season has, not paged.
- `PublicCompetitionService.isShown` re-reads a competition's divisions on every public read (no
  cache beyond the 30 second HTTP lifetime).
- The public fixture venue is the copied venue read model (`fixtures.venue`), eventually
  consistent with the scheduling event.
- The lobby shows the standings of at most two seasons (`?seasons=`), a fixed number of reads.
- `usePublicView` keeps the last public answer in the display preference store (`localStorage`).
- The staff waiting list panel issues one read per season card on the Teams home.
- Staff cannot take a competition private from the screen while `public_schedule` is off (the
  panel reads nothing then); the API allows it, and every public route answers "not available"
  while the switch is off.

## 5. Not verified

- No screen was looked at in a browser or on a device; staff tests run in jsdom, mobile tests in
  jest. The two themes were not compared visually: the public stylesheet uses theme tokens only
  and writes no colour, which is what makes both themes apply.
- The lobby display was not tried on a wall screen or with a real connection loss.
- The whole API suite was not run (by instruction); see the report for what was run.
- PostgreSQL: the waiting list specs (schema, API, concurrency), the two public view specs and
  the league journey were run against a local PostgreSQL 16 (`TEST_DATABASE_URL`); every other
  test was run under PGlite only.
- HTTP caches: `Cache-Control: public, max-age=30` is set and asserted; no cache or CDN was put in
  front of the API.
