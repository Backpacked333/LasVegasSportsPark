import type { Principal, SeasonFixture, TeamEntry } from '@sportspark/contracts';
import {
  CompetitionsService,
  DisputesService,
  FixtureGenerationService,
  FixturesService,
  ResultsService,
  RosterService,
  SeasonsService,
  TeamEntriesService,
  proposedRuleSetContent,
} from '../../modules/competition';
import { PublicCompetitionService } from '../../modules/competition/public/public-competition.service';
import { TeamWaitlistService } from '../../modules/competition/services/team-waitlist.service';
import { PublicScheduleService, ScheduleDraftsService } from '../../modules/scheduling';
import { calendarOf, optional, service, settle, type DemoContext } from './context';
import { ensureAdultBirthDate, seedAdults, type DemoAdult, type DemoStaff } from './people';
import type { DemoSpaces } from './spaces';

/**
 * The league (SPK-COMP-001 to 005, SPK-FIX-001 to 005, SPK-RESULT-001 to 004): a competition with
 * an active season, two divisions and eight teams with rosters; fixtures generated from a
 * specification and published through a schedule draft; results entered and published so the
 * standings are populated, and one result still awaiting review. With the amendments: the first
 * division is full, one team waits and one holds an open place offer (SPK-COMP-006), and the
 * competition is public, as is the facility's day schedule (SPK-SCHED-010). A second competition
 * is still being set up.
 */
export const LEAGUE_NAME = 'Friday night league';
export const DRAFT_COMPETITION_NAME = 'Spring cup';
export const SEASON_NAME = 'Winter season';

export interface DemoLeagueShell {
  competitionId: string;
  ruleSetId: string;
}

export interface DemoLeague extends DemoLeagueShell {
  seasonId: string;
  premierDivisionId: string;
  recreationalDivisionId: string;
  /** Approved entries by team name. */
  entries: Map<string, TeamEntry>;
  captains: Map<string, DemoAdult>;
  fixtures: SeasonFixture[];
  seasonPublicCode: string | null;
  facilityPublicCode: string | null;
}

const PREMIER = ['Desert Foxes', 'Red Rock Rovers', 'Neon City FC', 'Mojave United'];
const RECREATIONAL = ['Cactus Kickers', 'Joshua Tree FC', 'Boulder Bandits', 'Sandstorm SC'];
const WAITING = ['Canyon Comets', 'Sunset Strikers'];
const APPLIED = 'Mirage Athletic';

const GIVEN = ['Avery', 'Blake', 'Casey', 'Devon', 'Emery', 'Finley', 'Harper', 'Indigo'];
const FAMILY = ['Quill', 'Rowan', 'Sable', 'Tarn', 'Umber', 'Vale', 'Wren', 'Yarrow'];

/** Sample scores for the games already played, in fixture order. */
const SCORES: ReadonlyArray<[number, number]> = [
  [5, 3],
  [2, 2],
  [4, 6],
  [7, 4],
  [3, 1],
  [2, 5],
];

/** The rule set and the competitions: before the message sequence, which is before the season. */
export async function seedCompetitions(
  ctx: DemoContext,
  staff: DemoStaff,
): Promise<DemoLeagueShell> {
  const competitions = service(ctx, CompetitionsService);
  const league = staff.league.principal;
  const ruleSets = await competitions.listRuleSets(league, { latestOnly: true });
  const ruleSet =
    ruleSets.find((r) => r.name === 'Adult indoor rules') ??
    (await competitions.createRuleSet(
      league,
      {
        name: 'Adult indoor rules',
        format: 'indoor_boarded',
        content: proposedRuleSetContent('indoor_boarded'),
        policyReferences: [],
      },
      null,
    ));
  const listed = await competitions.list(league, {});
  const ensure = async (name: string, description: string): Promise<string> =>
    listed.find((c) => c.name === name)?.id ??
    (
      await competitions.create(
        league,
        { name, kind: 'league', sportFormat: 'indoor_boarded', description, policyReferences: [] },
        null,
      )
    ).id;
  const competitionId = await ensure(LEAGUE_NAME, 'Adult five-a-side, boards in play.');
  // The second competition stays as it was created: nothing public, no season yet.
  await ensure(DRAFT_COMPETITION_NAME, 'A one-weekend cup, still being planned.');
  return { competitionId, ruleSetId: ruleSet.id };
}

export async function seedLeague(
  ctx: DemoContext,
  staff: DemoStaff,
  spaces: DemoSpaces,
  shell: DemoLeagueShell,
  parent: Principal,
): Promise<DemoLeague> {
  const league = staff.league.principal;
  const calendar = calendarOf(ctx);
  const seasons = service(ctx, SeasonsService);
  const entriesService = service(ctx, TeamEntriesService);
  const roster = service(ctx, RosterService);
  const waitlist = service(ctx, TeamWaitlistService);
  const fixturesService = service(ctx, FixturesService);

  // Game night is yesterday's weekday: three rounds are played, three are still to come.
  const firstNight = -15;
  const existingSeasons = await seasons.listSeasons(league, { competitionId: shell.competitionId });
  let season = existingSeasons.find((s) => s.name === SEASON_NAME);
  if (!season) {
    season = await seasons.createSeason(
      league,
      {
        competitionId: shell.competitionId,
        name: SEASON_NAME,
        ruleSetId: shell.ruleSetId,
        startsOn: calendar.day(firstNight),
        endsOn: calendar.day(firstNight + 7 * 7),
        registrationOpensAt: calendar.iso(-35, '09:00'),
        registrationClosesAt: calendar.iso(-18, '21:00'),
        policyReferences: [],
      },
      null,
    );
    season = await seasons.updateSeason(
      league,
      season.id,
      { status: 'open', expectedRevision: season.revision, policyReferences: [] },
      null,
    );
    // The season's message schedule is produced by the follow-up of its creation.
    await settle(ctx);
  }
  const seasonId = season.id;

  const divisions = await seasons.listDivisions(league, seasonId);
  const ensureDivision = async (name: string, capacity: number, level: string): Promise<string> =>
    divisions.find((d) => d.name === name)?.id ??
    (
      await seasons.createDivision(
        league,
        {
          seasonId,
          name,
          // An adult league: stating it is what lets the competition be made public.
          criteria: {
            ageBand: { minAge: 18, maxAge: null },
            level,
            category: 'Adult',
            format: null,
          },
          facilityId: ctx.facilityId,
          capacityTeamEntries: capacity,
          policyReferences: [],
        },
        null,
      )
    ).id;
  const premierDivisionId = await ensureDivision('Premier', 4, 'Competitive');
  const recreationalDivisionId = await ensureDivision('Recreational', 6, 'Social');

  // One account per player: a captain and three more on every team, and the captains who wait.
  const teamNames = [...PREMIER, ...RECREATIONAL];
  const playerSpecs = teamNames.flatMap((team, teamIndex) =>
    [0, 1, 2, 3].map((slot) => ({
      key: `team-${teamIndex + 1}-${slot + 1}`,
      givenName: GIVEN[(teamIndex + slot * 3) % GIVEN.length] as string,
      familyName: `${FAMILY[(teamIndex * 3 + slot) % FAMILY.length] as string}-${team.split(' ')[0]}`,
    })),
  );
  const otherCaptains = [...WAITING, APPLIED].map((team, index) => ({
    key: `captain-${index + 1}`,
    givenName: GIVEN[(index + 5) % GIVEN.length] as string,
    familyName: `${FAMILY[(index + 2) % FAMILY.length] as string}-${team.split(' ')[0]}`,
  }));
  const adults = await seedAdults(ctx, [...playerSpecs, ...otherCaptains]);
  const player = (key: string): DemoAdult => adults.get(key) as DemoAdult;

  const listedEntries = await entriesService.list(league, { seasonId });
  const byTeam = new Map(listedEntries.map((e) => [e.teamName, e]));
  const captains = new Map<string, DemoAdult>();
  const approved = new Map<string, TeamEntry>();

  /**
   * The registration window closed before the season started, so a team is entered by the league
   * manager for its captain (customers cannot enter after the window), then placed in a division:
   * approved, or waiting when the division is full.
   */
  const enter = async (
    team: string,
    captain: DemoAdult,
    divisionId: string | null,
  ): Promise<TeamEntry> => {
    captains.set(team, captain);
    const known = byTeam.get(team);
    if (known) return known;
    const created = await entriesService.create(
      league,
      {
        seasonId,
        team: { name: team },
        captainPersonId: captain.personId,
        policyReferences: [],
      },
      null,
    );
    if (!divisionId) return created.entry;
    return entriesService.approve(
      league,
      created.entry.id,
      { divisionId, expectedRevision: created.entry.revision, policyReferences: [] },
      null,
    );
  };

  for (const [index, team] of teamNames.entries()) {
    const divisionId = index < PREMIER.length ? premierDivisionId : recreationalDivisionId;
    const captain = player(`team-${index + 1}-1`);
    const fresh = !byTeam.has(team);
    const entry = await enter(team, captain, divisionId);
    approved.set(team, entry);
    if (fresh) {
      const others = [2, 3, 4].map((slot) => player(`team-${index + 1}-${slot}`).personId);
      // The seeded parent plays for the Cactus Kickers, so the app's Teams tab has a team.
      if (team === 'Cactus Kickers' && parent.personId) {
        await ensureAdultBirthDate(ctx, parent.personId, 'dev-parent');
        others.push(parent.personId);
      }
      await roster.changeRoster(
        league,
        entry.id,
        {
          changes: others.map((personId, slot) => ({
            action: 'add' as const,
            personId,
            status: 'active' as const,
            jerseyNumber: slot + 2,
          })),
          policyReferences: [],
        },
        null,
      );
    }
  }

  // SPK-COMP-006: the Premier division is full, so the next two teams wait in order. Then the
  // manager adds a fifth place and offers it to the first team on the list.
  await optional(ctx, 'the waiting teams and the open place offer', async () => {
    const waiting: TeamEntry[] = [];
    for (const [index, team] of WAITING.entries()) {
      waiting.push(await enter(team, player(`captain-${index + 1}`), premierDivisionId));
    }
    const first = waiting[0] as TeamEntry;
    if (first.status !== 'waiting') return;
    const offers = await waitlist.offersOfEntry(league, first.id);
    if (offers.length > 0) return;
    const premier = await seasons.getDivision(league, premierDivisionId);
    if ((premier.capacityTeamEntries ?? 0) < 5) {
      await seasons.updateDivision(
        league,
        premierDivisionId,
        { capacityTeamEntries: 5, expectedRevision: premier.revision, policyReferences: [] },
        null,
      );
    }
    const current = await entriesService.getWorkspace(league, first.id);
    await waitlist.offer(
      league,
      first.id,
      { expectedRevision: current.entry.revision, policyReferences: [] },
      null,
    );
  });
  // An entry nobody has reviewed yet, so the team review queue has a row.
  await optional(ctx, 'the team entry awaiting review', () =>
    enter(APPLIED, player('captain-3'), null),
  );

  // Fixtures (SPK-FIX-001 to 005): a specification per division, generated into a schedule draft,
  // which the scheduler publishes.
  let fixtures = (await fixturesService.listForSeason(league, seasonId, { limit: 200 })).items;
  if (fixtures.length === 0) {
    const generation = service(ctx, FixtureGenerationService);
    const drafts = service(ctx, ScheduleDraftsService);
    const weekday = new Date(`${calendar.day(firstNight)}T12:00:00Z`).getUTCDay();
    for (const [name, divisionId, resourceId] of [
      ['Premier', premierDivisionId, spaces.field2],
      ['Recreational', recreationalDivisionId, spaces.field3],
    ] as const) {
      const specification = await generation.createSpecification(
        league,
        divisionId,
        {
          name: `${name}: double round robin`,
          facilityId: ctx.facilityId,
          gamesPerTeam: 6,
          opponentFrequency: 2,
          startsOn: calendar.day(firstNight),
          endsOn: calendar.day(firstNight + 7 * 6),
          blackouts: [],
          byesAllowed: true,
          minimumRestMinutes: 0,
          allowedStartTimes: [
            { weekday, time: '19:00' },
            { weekday, time: '20:00' },
          ],
          matchDurationMinutes: 50,
          requiredResourceIds: [resourceId],
          fairnessPreferences: [{ kind: 'home_away_balance', hard: false, weight: 2 }],
          policyReferences: [],
        },
        null,
      );
      const run = await generation.generate(
        league,
        specification.id,
        {
          searchSettings: { maxCandidates: 40, timeLimitMs: 5_000, seed: 7 },
          dryRun: false,
          draftName: `${SEASON_NAME}: ${name}`,
          policyReferences: [],
        },
        null,
      );
      if (!run.scheduleDraftId) {
        throw new Error(`the ${name} fixtures could not be generated (${run.outcome})`);
      }
      const draft = await drafts.get(staff.manager.principal, run.scheduleDraftId);
      await drafts.publish(staff.manager.principal, draft.id, { expectedRevision: draft.revision });
      await settle(ctx);
    }
    // The season is under way.
    const opened = await seasons.getSeason(league, seasonId);
    if (opened.status === 'open') {
      await seasons.updateSeason(
        league,
        seasonId,
        { status: 'active', expectedRevision: opened.revision, policyReferences: [] },
        null,
      );
    }
    fixtures = (await fixturesService.listForSeason(league, seasonId, { limit: 200 })).items;
  }

  // Results (SPK-RESULT-001 to 004): every game already played has a score. All are published
  // except the latest in each division, which waits for the league manager's review.
  const results = service(ctx, ResultsService);
  const now = ctx.clock.now().getTime();
  for (const divisionId of [premierDivisionId, recreationalDivisionId]) {
    const played = fixtures
      .filter((f) => f.divisionId === divisionId && f.scheduledEnd)
      .filter((f) => new Date(f.scheduledEnd as string).getTime() < now)
      .sort((a, b) => (a.scheduledStart as string).localeCompare(b.scheduledStart as string));
    for (const [index, fixture] of played.entries()) {
      const existing = await results.listForFixture(league, fixture.id);
      if (existing.length > 0) continue;
      const [homeScore, awayScore] = SCORES[index % SCORES.length] as [number, number];
      const last = index === played.length - 1;
      const submitted = await results.submit(
        league,
        fixture.id,
        { classification: 'completed', homeScore, awayScore, policyReferences: [] },
        null,
      );
      if (!last) {
        await results.publish(
          league,
          submitted.id,
          { expectedRevision: submitted.revision, policyReferences: [] },
          null,
        );
      }
    }
  }
  await settle(ctx);

  // A dispute (SPK-DISC-001): the captain of the team that lost the first Premier game questions
  // the score, so the disputes list has a case to decide.
  await optional(ctx, 'the open dispute', async () => {
    const disputes = service(ctx, DisputesService);
    const open = await disputes.list(league, { seasonId, limit: 10 });
    if (open.items.length > 0) return;
    const game = fixtures
      .filter((f) => f.divisionId === premierDivisionId && f.scheduledStart)
      .sort((a, b) => (a.scheduledStart as string).localeCompare(b.scheduledStart as string))[0];
    if (!game) return;
    const official = (await results.listForFixture(league, game.id)).find(
      (r) => r.status === 'official',
    );
    if (!official || official.homeScore === null || official.awayScore === null) return;
    const loser = official.homeScore < official.awayScore ? game.homeEntryId : game.awayEntryId;
    const team = [...approved.entries()].find(([, entry]) => entry.id === loser);
    const captain = team ? captains.get(team[0]) : undefined;
    if (!loser || !captain) return;
    await disputes.create(
      captain.principal,
      game.id,
      {
        teamEntryId: loser,
        resultRevisionId: official.id,
        reason: 'Our fourth goal was scored before the whistle and is missing from the score.',
        evidence: [],
        policyReferences: [],
      },
      null,
    );
  });
  await settle(ctx);

  // Public pages (SPK-SCHED-010): the competition and the facility's day schedule.
  let seasonPublicCode: string | null = null;
  let facilityPublicCode: string | null = null;
  await optional(ctx, 'the public competition pages', async () => {
    const publicCompetitions = service(ctx, PublicCompetitionService);
    let publication = await publicCompetitions.publication(league, shell.competitionId);
    if (publication.visibility !== 'public') {
      publication = await publicCompetitions.publish(
        league,
        shell.competitionId,
        { expectedRevision: publication.revision, policyReferences: [] },
        null,
      );
    }
    seasonPublicCode =
      publication.seasons.find((s) => s.seasonId === seasonId)?.publicCode ??
      publication.seasons[0]?.publicCode ??
      null;
  });
  await optional(ctx, "the facility's public day schedule", async () => {
    const publicSchedule = service(ctx, PublicScheduleService);
    let view = await publicSchedule.view(staff.manager.principal, ctx.facilityId);
    if (!view.enabled) {
      view = await publicSchedule.enable(
        staff.manager.principal,
        ctx.facilityId,
        { policyReferences: [] },
        null,
      );
    }
    facilityPublicCode = view.publicCode;
  });

  return {
    ...shell,
    seasonId,
    premierDivisionId,
    recreationalDivisionId,
    entries: approved,
    captains,
    fixtures,
    seasonPublicCode,
    facilityPublicCode,
  };
}
