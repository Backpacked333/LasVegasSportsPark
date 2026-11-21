import {
  CompetitionsService,
  FixturesService,
  ResultsService,
  SeasonsService,
  TeamEntriesService,
} from '../../modules/competition';
import { CareNotesService } from '../../modules/identity';
import {
  calendarOf,
  optional,
  requirePrincipal,
  service,
  settle,
  type DemoContext,
} from './context';
import { HOME_TEAM, AWAY_TEAM, YOUTH_DIVISION, YOUTH_LEAGUE, YOUTH_SEASON } from './parent-core';
import { seedAdults, type DemoStaff } from './people';
import type { DemoSpaces } from './spaces';

/**
 * The parent app's account screens as the redesign draws them (handoff Phase 3: M 1h Calendar,
 * M 1i Game day, M 2d Inbox, M 3e Child profile, M 5c Care notes; ADR-007 synthetic data). Runs
 * after `seedParentCore` (the Ortiz household, Maya's U9 league and today's game) and the front
 * desk's seed (Maya's training and Leo's class back to back today, at different spaces, which the
 * Calendar calls out; the camp week receipt with its refund request), and adds:
 *
 * - two more U9 teams (Red Rocks, Comets) and four played rounds with official results, so Game
 *   day shows standings with recent form and the playoff line, and the Inbox lists results;
 * - next week's game against the Comets, moved from Field 3 to Field 2 after it was published, so
 *   the Inbox shows a change with the old place struck through and the new one in bold;
 * - Maya's "If it happens" care instruction next to the desk's allergy note.
 *
 * Everything goes through the modules' services, found again by name before it is created
 * (idempotent), dated from the seed's clock in the facility's zone. Invented names only.
 */
export const RED_ROCKS = 'Red Rocks U9';
export const COMETS = 'Comets U9';

/** Played rounds: [round, days from today, home, away, home score, away score]. */
const PLAYED: ReadonlyArray<readonly [number, number, string, string, number, number]> = [
  [3, -21, HOME_TEAM, AWAY_TEAM, 2, 1],
  [3, -21, RED_ROCKS, COMETS, 3, 0],
  [4, -14, HOME_TEAM, RED_ROCKS, 1, 1],
  [4, -14, COMETS, AWAY_TEAM, 2, 2],
  [5, -10, RED_ROCKS, HOME_TEAM, 2, 0],
  [5, -10, AWAY_TEAM, COMETS, 0, 1],
  [6, -3, HOME_TEAM, COMETS, 3, 1],
  [6, -3, RED_ROCKS, AWAY_TEAM, 2, 0],
];

export async function seedParentAccount(
  ctx: DemoContext,
  staff: DemoStaff,
  spaces: DemoSpaces,
  mayaPersonId: string,
): Promise<void> {
  const league = staff.league.principal;
  const calendar = calendarOf(ctx);
  const competitions = service(ctx, CompetitionsService);
  const seasons = service(ctx, SeasonsService);
  const entries = service(ctx, TeamEntriesService);
  const fixtures = service(ctx, FixturesService);
  const results = service(ctx, ResultsService);

  const competition = (await competitions.list(league, {})).find((c) => c.name === YOUTH_LEAGUE);
  if (!competition) return;
  const season = (await seasons.listSeasons(league, { competitionId: competition.id })).find(
    (s) => s.name === YOUTH_SEASON,
  );
  if (!season) return;
  const division = (await seasons.listDivisions(league, season.id)).find(
    (d) => d.name === YOUTH_DIVISION,
  );
  if (!division) return;

  // Red Rocks and Comets: captained by invented adults (no players needed for the table).
  const listed = await entries.list(league, { seasonId: season.id });
  const firstRun = !listed.some((e) => e.teamName === RED_ROCKS);
  const captains = await seedAdults(ctx, [
    { key: 'youth-coach-rocks', givenName: 'Rosa', familyName: 'Sample-Vega' },
    { key: 'youth-coach-comets', givenName: 'Cole', familyName: 'Sample-Hart' },
  ]);
  const entryId = new Map(listed.map((e) => [e.teamName, e.id]));
  for (const [name, key] of [
    [RED_ROCKS, 'youth-coach-rocks'],
    [COMETS, 'youth-coach-comets'],
  ] as const) {
    if (entryId.has(name)) continue;
    const captain = captains.get(key);
    if (!captain) continue;
    await optional(ctx, `the ${name} team`, async () => {
      const created = await entries.create(
        league,
        {
          seasonId: season.id,
          team: { name },
          captainPersonId: captain.personId,
          policyReferences: [],
        },
        null,
      );
      const approved = await entries.approve(
        league,
        created.entry.id,
        { divisionId: division.id, expectedRevision: created.entry.revision, policyReferences: [] },
        null,
      );
      entryId.set(name, approved.id);
    });
  }
  await settle(ctx);

  // Four played rounds with official results (Game day standings, form, Inbox results).
  const existing = (await fixtures.listForSeason(league, season.id, { limit: 100 })).items;
  for (const [round, days, home, away, homeScore, awayScore] of PLAYED) {
    const homeId = entryId.get(home);
    const awayId = entryId.get(away);
    if (!homeId || !awayId) continue;
    if (existing.some((f) => f.round === round && f.homeEntryId === homeId)) continue;
    await optional(ctx, `round ${round}: ${home} vs ${away}`, async () => {
      const startAt = calendar.at(
        days,
        home === HOME_TEAM || away === HOME_TEAM ? '09:00' : '10:00',
      );
      const created = await fixtures.create(
        league,
        {
          seasonId: season.id,
          divisionId: division.id,
          round,
          homeEntryId: homeId,
          awayEntryId: awayId,
          schedule: {
            facilityId: ctx.facilityId,
            resourceIds: [home === HOME_TEAM || away === HOME_TEAM ? spaces.field2 : spaces.field3],
            scheduledStart: startAt.toISOString(),
            scheduledEnd: new Date(startAt.getTime() + 50 * 60_000).toISOString(),
            publish: true,
          },
          policyReferences: [],
        },
        null,
      );
      await settle(ctx);
      const submitted = await results.submit(
        league,
        created.fixture.id,
        { classification: 'completed', homeScore, awayScore, policyReferences: [] },
        null,
      );
      await results.publish(
        league,
        submitted.id,
        { expectedRevision: submitted.revision, policyReferences: [] },
        null,
      );
    });
  }
  await settle(ctx);

  // Next week's game, moved to another field after it was published (an Inbox change).
  const cometsId = entryId.get(COMETS);
  const foxesId = listed.find((e) => e.teamName === HOME_TEAM)?.id;
  if (cometsId && foxesId && !existing.some((f) => f.round === 8)) {
    await optional(ctx, 'next week’s game, moved to Field 2', async () => {
      const startAt = calendar.at(7, '09:00');
      const endAt = new Date(startAt.getTime() + 50 * 60_000);
      const created = await fixtures.create(
        league,
        {
          seasonId: season.id,
          divisionId: division.id,
          round: 8,
          homeEntryId: foxesId,
          awayEntryId: cometsId,
          schedule: {
            facilityId: ctx.facilityId,
            resourceIds: [spaces.field3],
            scheduledStart: startAt.toISOString(),
            scheduledEnd: endAt.toISOString(),
            publish: true,
          },
          policyReferences: [],
        },
        null,
      );
      await settle(ctx);
      await fixtures.update(
        league,
        created.fixture.id,
        {
          action: 'reschedule',
          schedule: {
            facilityId: ctx.facilityId,
            resourceIds: [spaces.field2],
            scheduledStart: startAt.toISOString(),
            scheduledEnd: endAt.toISOString(),
            publish: true,
          },
          expectedRevision: created.fixture.revision,
          reason: 'Field 3 is being re-lined.',
          policyReferences: [],
        },
        null,
      );
    });
  }
  await settle(ctx);

  // Maya's "If it happens" instruction, written once (reading care notes is itself audited, §4.14,
  // so a later run does not read them to find out: the first run is the one that adds the teams).
  if (firstRun) {
    await optional(ctx, "Maya's care instruction", async () => {
      const parent = await requirePrincipal(ctx, 'dev-parent');
      await service(ctx, CareNotesService).record(
        parent,
        mayaPersonId,
        {
          kind: 'care_instruction',
          body: 'EpiPen in the front pocket of her bag. Use it, then call 911 and me.',
          policyReferences: [],
        },
        null,
      );
    });
  }
  await settle(ctx);
}
