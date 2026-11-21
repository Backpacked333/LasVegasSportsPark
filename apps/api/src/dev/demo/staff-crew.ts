import type { Principal } from '@sportspark/contracts';
import {
  CompetitionsService,
  FixturesService,
  LineupsService,
  ResultsService,
  RosterService,
  SeasonsService,
  TeamEntriesService,
} from '../../modules/competition';
import { FieldPreparationsService, MaintenanceTasksService } from '../../modules/facilities';
import { PeopleService } from '../../modules/identity';
import { ClosuresService, EventsService, ResourcesService } from '../../modules/scheduling';
import { AssignmentsService, RequirementsService } from '../../modules/workforce';
import { calendarOf, optional, service, settle, type DemoContext } from './context';
import { YOUTH_LEAGUE, YOUTH_SEASON } from './parent-core';
import { ensureStaff, seedAdults, type DemoAdult, type DemoStaff } from './people';
import type { DemoSpaces } from './spaces';

/**
 * The staff screens of redesign Phase 8 ("specified, not yet drawn"), with synthetic data dated
 * from the seed's clock (ADR-007, invented names only), built through the modules' own services:
 *
 * - a field crew account (`demo-crew`, facilities operator) whose home is Fields;
 * - the coach's own team: "Hawks U10", captained by the development seed's coach, in a U10
 *   division of the youth league's season (apart from the U9 table the parent app shows), against
 *   "Sun Devils U10". Two games played in the last fortnight, each with the coach's game log and
 *   minutes per player (the bench's order); the older one has its official result, the latest is
 *   still unconfirmed (no referee's report yet). Today's game, at the first free pitch at least an
 *   hour and a quarter away, with the players' answers (7 going, 1 not going, 2 without an answer)
 *   and one referee required, offered to the development seed's official (a request on the
 *   referee's home; accepting it covers the slot Today lists). Next week's game too;
 * - today's pitch preparation by the crew: Field 1 ready, Field 2 two checks of four, Field 3 one;
 * - maintenance work for the tasks board: a corner flag being replaced on Field 1 (doing, the
 *   crew's), worn goalmouth turf on Field 2 (to do) and a leaking sprinkler on Field 5 (done).
 *
 * Every part is optional and idempotent (found again by name). Outside 07:00 to 21:00 at the
 * facility only the crew account is created: the day's work is not drawn at night.
 */
export const CREW_DEMO = {
  division: 'U10',
  team: 'Hawks U10',
  opponent: 'Sun Devils U10',
  corner: 'Corner flag snapped at the north-east corner; replace the pole and the base.',
  turf: 'Goalmouth turf worn bare at the south goal of Field 2.',
  sprinkler: 'Sprinkler head leaking by the halfway line.',
} as const;

const HAWKS = ['Ava', 'Ben', 'Cleo', 'Dev', 'Ema', 'Finn', 'Gia', 'Hugo', 'Isla', 'Jai'] as const;
/** Minutes in the two played games, by player (fewest first on the bench: Hugo, Isla, Jai). */
const MINUTES: ReadonlyArray<readonly [number, number]> = [
  [50, 50],
  [50, 40],
  [40, 50],
  [50, 30],
  [30, 40],
  [40, 30],
  [25, 30],
  [15, 10],
  [10, 20],
  [0, 10],
];
/** Answers for today's game (the last two have not answered). */
const ANSWERS: ReadonlyArray<'available' | 'unavailable' | null> = [
  'available',
  'available',
  'available',
  'available',
  'available',
  'available',
  'unavailable',
  'available',
  null,
  null,
];
const QUARTER = 15 * 60_000;
const MINUTE = 60_000;
const GAME_MINUTES = 50;

export async function seedStaffCrew(
  ctx: DemoContext,
  staff: DemoStaff,
  spaces: DemoSpaces,
): Promise<DemoAdult> {
  const crew = await ensureStaff(
    ctx,
    { subject: 'demo-crew', givenName: 'Marco', familyName: 'Sample-Diaz' },
    ['facilities_operator'],
  );
  const now = ctx.clock.now().getTime();
  const hour = Number(
    new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      hourCycle: 'h23',
      timeZone: ctx.timezone,
    }).format(new Date(now)),
  );
  if (hour < 7 || hour >= 21) return crew;

  await optional(ctx, "the coach's team and its games", () => seedCoachTeam(ctx, staff, spaces));
  await settle(ctx);
  await optional(ctx, "today's pitch preparation", () => seedPreparations(ctx, crew, spaces));
  await optional(ctx, 'the maintenance tasks board', () => seedTasks(ctx, staff, crew, spaces));
  await settle(ctx);
  return crew;
}

async function seedCoachTeam(ctx: DemoContext, staff: DemoStaff, spaces: DemoSpaces) {
  const league = staff.league.principal;
  const coach = staff.coach;
  const calendar = calendarOf(ctx);
  const competitions = service(ctx, CompetitionsService);
  const seasons = service(ctx, SeasonsService);
  const entries = service(ctx, TeamEntriesService);
  const roster = service(ctx, RosterService);
  const fixtures = service(ctx, FixturesService);
  const lineups = service(ctx, LineupsService);
  const results = service(ctx, ResultsService);

  const competition = (await competitions.list(league, {})).find((c) => c.name === YOUTH_LEAGUE);
  if (!competition) return;
  const season = (await seasons.listSeasons(league, { competitionId: competition.id })).find(
    (s) => s.name === YOUTH_SEASON,
  );
  if (!season) return;
  const divisionId =
    (await seasons.listDivisions(league, season.id)).find((d) => d.name === CREW_DEMO.division)
      ?.id ??
    (
      await seasons.createDivision(
        league,
        {
          seasonId: season.id,
          name: CREW_DEMO.division,
          criteria: {
            ageBand: { minAge: 8, maxAge: 10 },
            level: 'Recreational',
            category: 'Youth',
            format: '7v7',
          },
          facilityId: ctx.facilityId,
          capacityTeamEntries: 4,
          policyReferences: [],
        },
        null,
      )
    ).id;

  const listed = await entries.list(league, { seasonId: season.id });
  const team = async (name: string, captainPersonId: string, players: readonly string[]) => {
    const known = listed.find((e) => e.teamName === name);
    if (known) {
      const view = await roster.listRoster(league, known.id, { includeHistory: false });
      return { id: known.id, players: view.members.map((m) => m.personId) };
    }
    const created = await entries.create(
      league,
      { seasonId: season.id, team: { name }, captainPersonId, policyReferences: [] },
      null,
    );
    const approved = await entries.approve(
      league,
      created.entry.id,
      { divisionId, expectedRevision: created.entry.revision, policyReferences: [] },
      null,
    );
    if (players.length > 0) {
      await roster.changeRoster(
        league,
        approved.id,
        {
          changes: players.map((personId, slot) => ({
            action: 'add' as const,
            personId,
            status: 'active' as const,
            jerseyNumber: slot + 3,
            // On the roster since the start of the season, so the played games count them.
            effectiveFrom: calendar.iso(-20, '08:00'),
          })),
          reason: 'Demo dataset: the roster as it stood from the start of the season',
          policyReferences: [],
        },
        null,
      );
    }
    return { id: approved.id, players: [...players] };
  };
  const hawksKnown = listed.some((e) => e.teamName === CREW_DEMO.team);
  const hawks = await team(
    CREW_DEMO.team,
    coach.personId,
    hawksKnown ? [] : await createChildren(ctx, HAWKS, 'Sample-Hawk'),
  );
  const devilsCaptain = (
    await seedAdults(ctx, [
      { key: 'youth-coach-devils', givenName: 'Paula', familyName: 'Sample-Quinn' },
    ])
  ).get('youth-coach-devils') as DemoAdult;
  const devils = await team(CREW_DEMO.opponent, devilsCaptain.personId, []);
  // The players in their created order (the roster lists them by jersey).
  const players = [...hawks.players];
  await settle(ctx);

  const existing = (
    await fixtures.listForSeason(league, season.id, { teamEntryId: hawks.id, limit: 50 })
  ).items;
  const free = await freeTime(ctx, staff, spaces);
  const game = async (
    round: number,
    home: string,
    away: string,
    days: number,
    start: Date | null,
  ): Promise<string | null> => {
    const known = existing.find((f) => f.round === round);
    if (known) return known.id;
    const startAt = start ?? calendar.at(days, '10:00');
    const endAt = new Date(startAt.getTime() + GAME_MINUTES * MINUTE);
    const pitch = free(startAt.toISOString(), endAt.toISOString());
    if (!pitch) return null;
    const created = await fixtures.create(
      league,
      {
        seasonId: season.id,
        divisionId,
        round,
        homeEntryId: home,
        awayEntryId: away,
        schedule: {
          facilityId: ctx.facilityId,
          resourceIds: [pitch],
          scheduledStart: startAt.toISOString(),
          scheduledEnd: endAt.toISOString(),
          publish: true,
        },
        policyReferences: [],
      },
      null,
    );
    await settle(ctx);
    return created.fixture.id;
  };

  // Two played games with the coach's game log; the older one has its official result.
  const played: Array<{ id: string; hawksHome: boolean; score: [number, number] }> = [];
  const first = await game(1, hawks.id, devils.id, -14, null);
  if (first) played.push({ id: first, hawksHome: true, score: [3, 1] });
  const second = await game(2, devils.id, hawks.id, -7, null);
  if (second) played.push({ id: second, hawksHome: false, score: [1, 2] });
  for (const [index, g] of played.entries()) {
    const sheet = await lineups.teamSheet(coach.principal, g.id, { teamEntryId: hawks.id });
    if (!sheet.gameLog) {
      const [p0, p1, p2, p3] = players as [string, string, string, string];
      const ours = g.hawksHome ? g.score[0] : g.score[1];
      const events = [
        { kind: 'goal' as const, minute: 8, personId: p0, assistPersonId: p1 },
        { kind: 'opponent_goal' as const, minute: 17 },
        { kind: 'half_time' as const, minute: 25 },
        { kind: 'substitution' as const, minute: 30, offPersonId: p3, onPersonId: p2 },
        ...(ours > 1
          ? [{ kind: 'goal' as const, minute: 41, personId: p2, assistPersonId: null }]
          : []),
        ...(ours > 2
          ? [{ kind: 'goal' as const, minute: 47, personId: p1, assistPersonId: p0 }]
          : []),
      ];
      await lineups.recordGameLog(
        coach.principal,
        g.id,
        {
          teamEntryId: hawks.id,
          homeScore: g.score[0],
          awayScore: g.score[1],
          events,
          minutes: players.map((personId, i) => ({
            personId,
            minutes: MINUTES[i]?.[index] ?? 0,
          })),
          policyReferences: [],
        },
        null,
      );
    }
    // The older game has its official result; the latest waits for the referee's report.
    if (index === 0 && !sheet.officialResult) {
      const submitted = await results.submit(
        league,
        g.id,
        {
          classification: 'completed',
          homeScore: g.score[0],
          awayScore: g.score[1],
          policyReferences: [],
        },
        null,
      );
      await results.publish(
        league,
        submitted.id,
        { expectedRevision: submitted.revision, policyReferences: [] },
        null,
      );
    }
  }
  await settle(ctx);

  // Today's game at the first free pitch at least 75 minutes away, before 20:00; then next week.
  const earliest = Math.ceil((ctx.clock.now().getTime() + 75 * MINUTE) / QUARTER) * QUARTER;
  const lastStart = calendar.at(0, '19:00').getTime();
  let today: string | null = existing.find((f) => f.round === 3)?.id ?? null;
  for (let start = earliest; !today && start <= lastStart; start += QUARTER) {
    const startIso = new Date(start).toISOString();
    if (!free(startIso, new Date(start + GAME_MINUTES * MINUTE).toISOString())) continue;
    today = await game(3, hawks.id, devils.id, 0, new Date(start));
  }
  await game(4, devils.id, hawks.id, 7, null);
  if (!today) return;

  const counts = (await fixtures.get(league, today)).home.availability;
  if (counts.available + counts.unavailable + counts.tentative === 0) {
    for (const [index, personId] of players.entries()) {
      const state = ANSWERS[index] ?? null;
      if (!state) continue;
      await fixtures.recordAvailability(league, today, { personId, state }, null);
    }
  }
  await refereeRequest(ctx, league, today, staff.official);
}

/** One referee required for the game, offered to the official (a request on the referee home). */
async function refereeRequest(
  ctx: DemoContext,
  by: Principal,
  fixtureId: string,
  official: DemoAdult,
): Promise<void> {
  const assignments = service(ctx, AssignmentsService);
  const requirements = service(ctx, RequirementsService);
  const already = await assignments.list(by, {
    targetType: 'fixture',
    targetId: fixtureId,
    limit: 10,
    order: 'asc',
  });
  if (already.items.length > 0) return;
  await requirements.create(
    by,
    {
      targetType: 'fixture',
      targetId: fixtureId,
      kind: 'official',
      role: 'referee',
      requiredCount: 1,
      mustBeAccepted: true,
      requiredQualifications: [],
      policyReferences: [],
    },
    null,
  );
  await assignments.create(
    by,
    {
      personId: official.personId,
      kind: 'official',
      role: 'referee',
      engagement: 'regular',
      offer: true,
      targetType: 'fixture',
      targetId: fixtureId,
      policyReferences: [],
    },
    null,
  );
}

async function createChildren(
  ctx: DemoContext,
  names: readonly string[],
  familyName: string,
): Promise<string[]> {
  const people = service(ctx, PeopleService);
  const year = Number(calendarOf(ctx).today.slice(0, 4));
  const ids: string[] = [];
  for (const [index, givenName] of names.entries()) {
    const person = await people.createPerson(
      ctx.system,
      {
        kind: 'child',
        givenName,
        familyName,
        dateOfBirth: `${year - 10 + (index % 2)}-09-01`,
        contactPoints: [],
      },
      null,
    );
    ids.push(person.id);
  }
  return ids;
}

/**
 * A function that names a pitch free for a period, or null: no event and no closure holds that
 * ground then (a pitch and its halves share conflict units). Read once; the caller adds nothing it
 * has not checked.
 */
async function freeTime(ctx: DemoContext, staff: DemoStaff, spaces: DemoSpaces) {
  const manager = staff.manager.principal;
  const calendar = calendarOf(ctx);
  const resources = await service(ctx, ResourcesService).listResources(manager, ctx.facilityId);
  const listed: Array<{ scheduledStart: string; scheduledEnd: string; resourceIds: string[] }> = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10; page += 1) {
    const result = await service(ctx, EventsService).listEvents(manager, {
      facilityId: ctx.facilityId,
      start: calendar.iso(-21, '00:00'),
      end: calendar.iso(14, '00:00'),
      limit: 200,
      ...(cursor ? { cursor } : {}),
    });
    listed.push(...result.items.filter((e) => e.status !== 'canceled'));
    if (!result.nextCursor) break;
    cursor = result.nextCursor;
  }
  const closures = (
    await service(ctx, ClosuresService).listClosures(manager, ctx.facilityId)
  ).filter((c) => c.status === 'active' || c.status === 'pending');
  const units = new Map(resources.map((r) => [r.id, r.conflictUnitIds]));
  const sameGround = (a: string, b: string): boolean =>
    a === b || (units.get(a) ?? []).some((u) => (units.get(b) ?? []).includes(u));
  const field5 = resources.find((r) => r.name === 'Field 5')?.id;
  const pitches = [spaces.field1, spaces.field3, field5, spaces.field2].filter(
    (p): p is string => !!p,
  );
  return (start: string, end: string): string | null => {
    const s = Date.parse(start);
    const e = Date.parse(end);
    const overlaps = (a: string, b: string) => Date.parse(a) < e && s < Date.parse(b);
    return (
      pitches.find(
        (pitch) =>
          !listed.some(
            (x) =>
              overlaps(x.scheduledStart, x.scheduledEnd) &&
              x.resourceIds.some((id) => sameGround(id, pitch)),
          ) &&
          !closures.some(
            (c) =>
              (c.resourceId === null || sameGround(c.resourceId, pitch)) &&
              overlaps(c.interval.start, c.interval.end),
          ),
      ) ?? null
    );
  };
}

/** Today's preparation: Field 1 ready, Field 2 two checks of four, Field 3 one. */
async function seedPreparations(ctx: DemoContext, crew: DemoAdult, spaces: DemoSpaces) {
  const preparations = service(ctx, FieldPreparationsService);
  const day = await preparations.list(crew.principal, { facilityId: ctx.facilityId });
  const plan: Array<
    [string, Array<'lines' | 'goals_anchored' | 'nets' | 'corner_flags'>, boolean]
  > = [
    [spaces.field1, ['lines', 'goals_anchored', 'nets', 'corner_flags'], true],
    [spaces.field2, ['lines', 'nets'], false],
    [spaces.field3, ['lines'], false],
  ];
  for (const [resourceId, checkedItems, ready] of plan) {
    if (day.items.some((p) => p.resourceId === resourceId)) continue;
    const recorded = await preparations.record(crew.principal, {
      facilityId: ctx.facilityId,
      resourceId,
      date: day.date,
      checkedItems,
      policyReferences: [],
    });
    if (ready) {
      await preparations.markReady(crew.principal, recorded.id, {
        expectedRevision: recorded.revision,
        policyReferences: [],
      });
    }
  }
}

/** The tasks board: Field 1's corner flag (doing), Field 2's goalmouth (to do), Field 5 (done). */
async function seedTasks(ctx: DemoContext, staff: DemoStaff, crew: DemoAdult, spaces: DemoSpaces) {
  const tasks = service(ctx, MaintenanceTasksService);
  const manager = staff.manager.principal;
  const listed = await tasks.list(manager, { facilityId: ctx.facilityId, limit: 100 });
  const has = (issue: string) => listed.items.some((t) => t.issue === issue);
  const resources = await service(ctx, ResourcesService).listResources(manager, ctx.facilityId);
  const field5 = resources.find((r) => r.name === 'Field 5')?.id ?? spaces.field3;

  if (!has(CREW_DEMO.corner)) {
    const task = await tasks.reportIssue(crew.principal, {
      facilityId: ctx.facilityId,
      resourceId: spaces.field1,
      issue: CREW_DEMO.corner,
      severity: 'medium',
      requiresInspection: false,
    });
    const assigned = await tasks.update(manager, task.id, {
      assignedOwnerPersonId: crew.personId,
      expectedRevision: task.revision,
    });
    await tasks.update(crew.principal, task.id, {
      status: 'in_progress',
      expectedRevision: assigned.revision,
    });
  }
  if (!has(CREW_DEMO.turf)) {
    await tasks.reportIssue(staff.coach.principal, {
      facilityId: ctx.facilityId,
      resourceId: spaces.field2,
      issue: CREW_DEMO.turf,
      severity: 'high',
      requiresInspection: false,
    });
  }
  if (!has(CREW_DEMO.sprinkler)) {
    const task = await tasks.reportIssue(crew.principal, {
      facilityId: ctx.facilityId,
      resourceId: field5,
      issue: CREW_DEMO.sprinkler,
      severity: 'low',
      requiresInspection: false,
    });
    await tasks.update(crew.principal, task.id, {
      status: 'resolved',
      resolution: { summary: 'Sprinkler head replaced; no leak after a ten-minute run.' },
      expectedRevision: task.revision,
    });
  }
}
