import type { Principal } from '@sportspark/contracts';
import { UnitOfWork } from '../../kernel/database/unit-of-work';
import {
  CompetitionsService,
  FixturesService,
  RosterService,
  SeasonsService,
  TeamEntriesService,
  proposedRuleSetContent,
} from '../../modules/competition';
import { ObligationsService } from '../../modules/finance';
import {
  ALL_PERMISSIONS,
  AuthorityReadsService,
  HouseholdsService,
  PeopleService,
  RelationshipAuthority,
  RelationshipsService,
} from '../../modules/identity';
import { calendarOf, requirePrincipal, service, settle, type DemoContext } from './context';
import { seedAdults, type DemoAdult, type DemoStaff } from './people';
import type { DemoSpaces } from './spaces';

/**
 * The seeded parent's Home as the parent-app redesign draws it (handoff M 1b, Phase 1; ADR-007
 * synthetic data): the demo parent is "Dana Ortiz", her first child "Maya" (8, the development
 * seed's child) and a second child "Leo" (5) in the same household; Maya plays in a youth league
 * whose game is today, with other players' answers recorded; Maya has a league fee to pay; Leo
 * has no waiver yet (so "Sign" and "Also sign for Maya" show). Everything goes through the
 * modules' services, found again by name before it is created (idempotent), and is dated from the
 * seed's clock in the facility's zone. Invented names only.
 *
 * Not built here (left to the screens' own flows or the staff app): a cancelled game (cancel the
 * game from the staff schedule to see Home's red card) and a class for Leo.
 */
export const YOUTH_LEAGUE = 'Fall youth league';
export const YOUTH_SEASON = 'Fall season';
export const YOUTH_DIVISION = 'U9';
export const HOME_TEAM = 'Desert Foxes U9';
export const AWAY_TEAM = 'Lions U9';
export const FEE_DESCRIPTION = 'Spring Rec League';

const OTHER_PLAYERS = [
  'Ava',
  'Noah',
  'Mia',
  'Eli',
  'Zoe',
  'Kai',
  'Ivy',
  'Leo B',
  'Ada',
  'Max',
  'Uma',
] as const;
const LIONS = ['Ari', 'Bea', 'Cal', 'Dax', 'Eve', 'Fin'] as const;

/** Answers of Maya's teammates: 7 going, 1 maybe, 1 not going, 2 not answered yet. */
const ANSWERS: ReadonlyArray<'available' | 'tentative' | 'unavailable' | null> = [
  'available',
  'available',
  'available',
  'available',
  'available',
  'available',
  'available',
  'tentative',
  'unavailable',
  null,
  null,
];

function birthDateFor(today: string, age: number): string {
  return `${Number(today.slice(0, 4)) - age - 1}-12-01`;
}

async function rename(ctx: DemoContext, personId: string, givenName: string, familyName: string) {
  const people = service(ctx, PeopleService);
  const person = await people.getPerson(ctx.system, personId);
  if (person.givenName === givenName && person.familyName === familyName) return;
  await people.updatePerson(
    ctx.system,
    personId,
    { givenName, familyName, expectedRevision: person.revision, policyReferences: [] },
    null,
  );
}

/** A child under the parent's guardianship (all six permissions) and in their household. */
async function ensureChild(
  ctx: DemoContext,
  parent: Principal,
  givenName: string,
  age: number,
): Promise<string> {
  const people = service(ctx, PeopleService);
  const parentId = parent.personId as string;
  const authorities = await service(ctx, RelationshipAuthority).authoritiesOf(
    ctx.organizationId,
    parentId,
  );
  const names = await people.personNames(
    ctx.system,
    authorities.map((a) => a.subjectPersonId),
  );
  const known = names.find((n) => n.givenName === givenName && n.familyName === 'Ortiz');
  if (known) return known.personId;
  const child = await people.createPerson(
    ctx.system,
    {
      kind: 'child',
      givenName,
      familyName: 'Ortiz',
      dateOfBirth: birthDateFor(calendarOf(ctx).today, age),
      contactPoints: [],
    },
    null,
  );
  await service(ctx, UnitOfWork).run(({ trx }) =>
    service(ctx, RelationshipsService).ensureAuthority(trx, ctx.system, ctx.organizationId, {
      actorPersonId: parentId,
      subjectPersonId: child.id,
      kind: 'guardian',
      permissions: ALL_PERMISSIONS,
      source: 'staff',
      correlationId: null,
    }),
  );
  const [household] = await service(ctx, AuthorityReadsService).myHouseholds(parent);
  if (household) {
    await service(ctx, HouseholdsService).addMember(
      ctx.system,
      household.id,
      { personId: child.id },
      null,
    );
  }
  return child.id;
}

/** Players without an account: a name and a date of birth inside the division's age band. */
async function createPlayers(
  ctx: DemoContext,
  names: readonly string[],
  familyName: string,
): Promise<string[]> {
  const people = service(ctx, PeopleService);
  const today = calendarOf(ctx).today;
  const ids: string[] = [];
  for (const [index, givenName] of names.entries()) {
    const person = await people.createPerson(
      ctx.system,
      {
        kind: 'child',
        givenName,
        familyName,
        dateOfBirth: birthDateFor(today, 7 + (index % 2)),
        contactPoints: [],
      },
      null,
    );
    ids.push(person.id);
  }
  return ids;
}

/**
 * Today's game time: 9:00 when the morning is still ahead, else the next quarter hour at least two
 * hours away (a game later today), else 9:00 tomorrow (late in the evening).
 */
export function gameStart(ctx: DemoContext): { days: number; time: string } {
  const now = ctx.clock.now();
  const calendar = calendarOf(ctx);
  if (now.getTime() < calendar.at(0, '08:00').getTime()) return { days: 0, time: '09:00' };
  for (const hour of [11, 13, 15, 17]) {
    const time = `${String(hour).padStart(2, '0')}:00`;
    if (calendar.at(0, time).getTime() - now.getTime() >= 2 * 3_600_000) return { days: 0, time };
  }
  return { days: 1, time: '09:00' };
}

/**
 * The household of the design: the demo parent is Dana Ortiz, the development seed's child is
 * Maya (8) and Leo (5) joins them. Runs early (before the front desk's seed, which scans this same
 * family) and again from `seedParentCore`; a second run changes nothing.
 */
export async function nameParentHousehold(
  ctx: DemoContext,
  devChildPersonId: string,
): Promise<void> {
  const parent = await requirePrincipal(ctx, 'dev-parent');
  await rename(ctx, parent.personId as string, 'Dana', 'Ortiz');
  await rename(ctx, devChildPersonId, 'Maya', 'Ortiz');
  await ensureChild(ctx, parent, 'Leo', 5);
}

export async function seedParentCore(
  ctx: DemoContext,
  staff: DemoStaff,
  spaces: DemoSpaces,
  devChildPersonId: string,
): Promise<void> {
  const calendar = calendarOf(ctx);
  const parent = await requirePrincipal(ctx, 'dev-parent');
  const league = staff.league.principal;

  await nameParentHousehold(ctx, devChildPersonId);

  // Maya's league fee, due in six days (Home › To do › Pay $120).
  const obligations = service(ctx, ObligationsService);
  const owed = await obligations.list(staff.manager.principal, {
    debtorPersonId: devChildPersonId,
    limit: 50,
  });
  if (!owed.items.some((o) => o.description === FEE_DESCRIPTION)) {
    await obligations.create(
      staff.manager.principal,
      {
        debtor: { kind: 'person', personId: devChildPersonId },
        mode: 'individual',
        amountMinor: 12_000,
        currency: 'USD',
        dueAt: calendar.iso(6, '18:00'),
        description: FEE_DESCRIPTION,
        source: { kind: 'manual' },
        policyReferences: [],
      },
      null,
    );
  }

  // A youth league with Maya's game today and her teammates' answers.
  const competitions = service(ctx, CompetitionsService);
  const seasons = service(ctx, SeasonsService);
  const entries = service(ctx, TeamEntriesService);
  const roster = service(ctx, RosterService);
  const fixtures = service(ctx, FixturesService);

  const ruleSets = await competitions.listRuleSets(league, { latestOnly: true });
  const ruleSet =
    ruleSets.find((r) => r.name === 'Youth outdoor rules') ??
    (await competitions.createRuleSet(
      league,
      {
        name: 'Youth outdoor rules',
        format: 'outdoor',
        content: proposedRuleSetContent('outdoor'),
        policyReferences: [],
      },
      null,
    ));
  const competitionId =
    (await competitions.list(league, {})).find((c) => c.name === YOUTH_LEAGUE)?.id ??
    (
      await competitions.create(
        league,
        {
          name: YOUTH_LEAGUE,
          kind: 'league',
          sportFormat: 'outdoor',
          description: 'Saturday youth soccer, 7v7.',
          policyReferences: [],
        },
        null,
      )
    ).id;
  let season = (await seasons.listSeasons(league, { competitionId })).find(
    (s) => s.name === YOUTH_SEASON,
  );
  if (!season) {
    season = await seasons.createSeason(
      league,
      {
        competitionId,
        name: YOUTH_SEASON,
        ruleSetId: ruleSet.id,
        startsOn: calendar.day(-21),
        endsOn: calendar.day(35),
        registrationOpensAt: calendar.iso(-60, '09:00'),
        registrationClosesAt: calendar.iso(-28, '21:00'),
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
    await settle(ctx);
  }
  const seasonId = season.id;
  const divisionId =
    (await seasons.listDivisions(league, seasonId)).find((d) => d.name === YOUTH_DIVISION)?.id ??
    (
      await seasons.createDivision(
        league,
        {
          seasonId,
          name: YOUTH_DIVISION,
          criteria: {
            ageBand: { minAge: 6, maxAge: 9 },
            level: 'Recreational',
            category: 'Youth',
            format: '7v7',
          },
          facilityId: ctx.facilityId,
          capacityTeamEntries: 6,
          policyReferences: [],
        },
        null,
      )
    ).id;

  const coaches = await seedAdults(ctx, [
    { key: 'youth-coach-foxes', givenName: 'Ana', familyName: 'Sample-Ruiz' },
    { key: 'youth-coach-lions', givenName: 'Theo', familyName: 'Sample-Brandt' },
  ]);
  const listed = await entries.list(league, { seasonId });
  /** The team and its players (the roster, read again on a later run). */
  const team = async (
    name: string,
    captain: DemoAdult,
    newPlayers: () => Promise<readonly string[]>,
  ) => {
    const known = listed.find((e) => e.teamName === name);
    if (known) {
      const view = await roster.listRoster(league, known.id, { includeHistory: false });
      return { entry: known, players: view.members.map((m) => m.personId) };
    }
    const players = await newPlayers();
    const created = await entries.create(
      league,
      { seasonId, team: { name }, captainPersonId: captain.personId, policyReferences: [] },
      null,
    );
    const approved = await entries.approve(
      league,
      created.entry.id,
      { divisionId, expectedRevision: created.entry.revision, policyReferences: [] },
      null,
    );
    await roster.changeRoster(
      league,
      approved.id,
      {
        changes: players.map((personId, slot) => ({
          action: 'add' as const,
          personId,
          status: 'active' as const,
          jerseyNumber: slot + 2,
        })),
        policyReferences: [],
      },
      null,
    );
    return { entry: approved, players };
  };
  const foxesTeam = await team(
    HOME_TEAM,
    coaches.get('youth-coach-foxes') as DemoAdult,
    async () => [devChildPersonId, ...(await createPlayers(ctx, OTHER_PLAYERS, 'Sample-Fox'))],
  );
  const lionsTeam = await team(AWAY_TEAM, coaches.get('youth-coach-lions') as DemoAdult, () =>
    createPlayers(ctx, LIONS, 'Sample-Lion'),
  );
  const foxes = foxesTeam.entry;
  const lions = lionsTeam.entry;
  const foxesPlayers = [
    devChildPersonId,
    ...foxesTeam.players.filter((id) => id !== devChildPersonId),
  ];

  const existing = (await fixtures.listForSeason(league, seasonId, { limit: 50 })).items;
  let game = existing.find((f) => f.homeEntryId === foxes.id && f.awayEntryId === lions.id);
  if (!game) {
    const start = gameStart(ctx);
    const startAt = calendar.at(start.days, start.time);
    const created = await fixtures.create(
      league,
      {
        seasonId,
        divisionId,
        round: 7,
        homeEntryId: foxes.id,
        awayEntryId: lions.id,
        schedule: {
          facilityId: ctx.facilityId,
          resourceIds: [spaces.field2],
          scheduledStart: startAt.toISOString(),
          scheduledEnd: new Date(startAt.getTime() + 50 * 60_000).toISOString(),
          publish: true,
        },
        policyReferences: [],
      },
      null,
    );
    game = created.fixture as unknown as typeof game;
    await settle(ctx);
  }
  const gameId = (game as { id: string }).id;
  // Teammates' answers, recorded by the league manager as a coach would relay them; an answer
  // recorded on an earlier run stands (CMP-04).
  const counts = (await fixtures.get(league, gameId)).home.availability;
  const answeredBefore = counts.available + counts.tentative + counts.unavailable > 0;
  for (const [index, personId] of foxesPlayers.slice(1).entries()) {
    const state = ANSWERS[index] ?? null;
    if (!state || answeredBefore) continue;
    await fixtures.recordAvailability(league, gameId, { personId, state }, null);
  }
  await settle(ctx);
}
