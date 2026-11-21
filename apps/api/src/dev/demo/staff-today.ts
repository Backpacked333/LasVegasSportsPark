import type { Principal } from '@sportspark/contracts';
import { SessionsService } from '../../modules/catalog';
import { FixturesService, RosterService } from '../../modules/competition';
import { RestrictionsService } from '../../modules/facilities';
import { EventsService, ResourcesService } from '../../modules/scheduling';
import {
  AssignmentsService,
  AvailabilityService,
  RequirementsService,
} from '../../modules/workforce';
import type { DemoCatalog } from './catalog';
import { optional, service, settle, type DemoContext } from './context';
import type { DemoLeague } from './league';
import { ensureStaff, seedAdults, type DemoAdult, type DemoStaff } from './people';
import type { DemoSpaces } from './spaces';

/**
 * The staff Today screen as the redesign draws it (S 1a, S 3a, S 1d): the hour after the seed's
 * clock is busy. Everything is dated from that clock (the next quarter hour at least ten minutes
 * away is "T0") and built through the modules' own services, as the staff who would do it:
 *
 * - two more pitches, Field 4 closed for an irrigation repair (a facilities restriction until
 *   T0 + 4 h) and Field 5;
 * - two friendly games at T0 on Field 2 and Field 3 (league teams, outside the divisions, so the
 *   standings and the published season schedule are unchanged), each needing one referee: Field
 *   3's referee accepted; Field 2's slot is open, so Today offers ranked candidates (one declared
 *   available, one not);
 * - a class session at T0 + 15 on the court (an extra session of the small class, whose enrolled
 *   children include families without a current waiver);
 * - a practice on Field 1's north half running now (ends T0 + 15) and drop-in on the court (ends
 *   T0 + 5), so the field board has things in progress;
 * - a rental on Field 5 at T0 + 30 for two hours and a birthday party in the party room at T0 + 45,
 *   as scheduled events on their spaces.
 *
 * Every part is optional: a refusal (a clash with another part of the dataset on the day it runs)
 * is reported in the summary and the rest is still built. When the busy hour would fall outside the
 * facility's opening hours (the seed runs at night), nothing is added: Today is quiet at night.
 * Idempotent by titles and start times.
 */
const QUARTER = 15 * 60_000;
const MINUTE = 60_000;

export const TODAY_DEMO_TITLES = {
  practice: 'U12 Strikers practice',
  dropIn: 'Open gym (drop-in)',
  rental: 'Garcia rental',
  party: "Sofia's 9th birthday",
  repair: 'Irrigation repair',
} as const;

export interface DemoStaffToday {
  /** The first start of the busy hour. */
  t0: string;
  fixtureIds: string[];
}

export async function seedStaffToday(
  ctx: DemoContext,
  staff: DemoStaff,
  spaces: DemoSpaces,
  catalog: DemoCatalog,
  league: DemoLeague,
): Promise<DemoStaffToday> {
  const manager = staff.manager.principal;
  const leagueManager = staff.league.principal;
  const now = ctx.clock.now().getTime();
  const t0 = Math.ceil((now + 10 * MINUTE) / QUARTER) * QUARTER;
  const at = (minutes: number): string => new Date(t0 + minutes * MINUTE).toISOString();
  const hourOf = (instant: number): number =>
    Number(
      new Intl.DateTimeFormat('en-US', {
        hour: 'numeric',
        hourCycle: 'h23',
        timeZone: ctx.timezone,
      }).format(new Date(instant)),
    );
  // The busy hour runs from T0 - 1 h to T0 + 2 h 45; the spaces open 07:00 to 23:00.
  const firstHour = hourOf(now - 60 * MINUTE);
  const lastHour = hourOf(t0 + 170 * MINUTE);
  if (firstHour < 7 || lastHour < firstHour || lastHour >= 23) {
    ctx.log('  the busy hour on Today is skipped: outside opening hours');
    return { t0: new Date(t0).toISOString(), fixtureIds: [] };
  }
  const events = service(ctx, EventsService);
  const resources = service(ctx, ResourcesService);

  // Spaces: Field 4 and Field 5 (whole pitches, the same formats as the others).
  const known = await resources.listResources(manager, ctx.facilityId);
  const ensurePitch = async (name: string): Promise<string> =>
    known.find((r) => r.name === name)?.id ??
    (
      await resources.createResource(manager, {
        facilityId: ctx.facilityId,
        name,
        kind: 'pitch',
        compatibleFormats: ['7v7', '5v5', 'indoor_boarded'],
        defaultSetupMinutes: 0,
        defaultCleanupMinutes: 0,
        policyReferences: [],
      })
    ).id;
  const field4 = await ensurePitch('Field 4');
  const field5 = await ensurePitch('Field 5');

  // What already stands on the day, so a re-run creates nothing twice.
  const listed = await events.listEvents(manager, {
    facilityId: ctx.facilityId,
    start: new Date(now - 3 * 60 * MINUTE).toISOString(),
    end: new Date(t0 + 6 * 60 * MINUTE).toISOString(),
    limit: 200,
  });
  const has = (title: string): boolean =>
    listed.items.some((e) => e.title === title && e.status !== 'canceled');

  const direct = async (
    title: string,
    kind: 'practice' | 'pickup' | 'rental' | 'party',
    resourceId: string,
    from: number,
    to: number,
  ): Promise<void> => {
    if (has(title)) return;
    await events.createEvent(manager, {
      facilityId: ctx.facilityId,
      kind,
      title,
      sport: kind === 'party' ? null : 'soccer',
      scheduledStart: from > 0 ? at(from) : new Date(now + from * MINUTE).toISOString(),
      scheduledEnd: at(to),
      resourceIds: [resourceId],
      sourceType: 'manual',
      sourceId: ctx.facilityId,
      status: 'published',
      reason: 'Demo dataset: the busy hour on Today',
    });
  };

  await optional(ctx, 'the practice in progress on Field 1', () =>
    direct(TODAY_DEMO_TITLES.practice, 'practice', spaces.field1North, -45, 15),
  );
  await optional(ctx, 'drop-in on the court', () =>
    direct(TODAY_DEMO_TITLES.dropIn, 'pickup', spaces.court, -55, 5),
  );
  await optional(ctx, 'the rental on Field 5', () =>
    direct(TODAY_DEMO_TITLES.rental, 'rental', field5, 30, 150),
  );
  await optional(ctx, 'the birthday party', () =>
    direct(TODAY_DEMO_TITLES.party, 'party', spaces.partyRoom, 45, 165),
  );

  // Field 4 is closed for a repair until T0 + 4 h (approved, so it is in effect now).
  await optional(ctx, 'the Field 4 restriction', async () => {
    const restrictions = service(ctx, RestrictionsService);
    const existing = await restrictions.list(manager, { facilityId: ctx.facilityId });
    if (existing.some((r) => r.resourceId === field4 && r.reason === TODAY_DEMO_TITLES.repair)) {
      return;
    }
    await restrictions.create(manager, {
      facilityId: ctx.facilityId,
      resourceId: field4,
      kind: 'closed',
      interval: { start: new Date(now - 2 * 60 * MINUTE).toISOString(), end: at(240) },
      reason: TODAY_DEMO_TITLES.repair,
      approve: true,
      policyReferences: [],
    });
  });

  // The class session at T0 + 15 on the court: an extra session of the term class.
  await optional(ctx, 'the class session on the court', async () => {
    const title = catalog.smallClass.name;
    const start = at(15);
    if (listed.items.some((e) => e.title === title && e.scheduledStart === start)) return;
    const event = await events.createEvent(manager, {
      facilityId: ctx.facilityId,
      kind: 'session',
      title,
      sport: 'soccer',
      scheduledStart: start,
      scheduledEnd: at(75),
      resourceIds: [spaces.court],
      commitments: [{ partyType: 'person', partyId: staff.coach.personId, role: 'coach' }],
      sourceType: 'offering',
      sourceId: catalog.smallClass.id,
      status: 'published',
      reason: 'Demo dataset: an extra session',
    });
    await service(ctx, SessionsService).create(
      manager,
      catalog.smallClass.id,
      {
        scheduledStart: event.scheduledStart,
        scheduledEnd: event.scheduledEnd,
        schedulingEventId: event.id,
        policyReferences: [],
      },
      null,
    );
  });

  // Officials: three more, so the open slot has ranked candidates and a decline to show.
  const officials = {
    nguyen: await ensureStaff(
      ctx,
      { subject: 'demo-official-nguyen', givenName: 'Taylor', familyName: 'Nguyen' },
      ['official'],
    ),
    osei: await ensureStaff(
      ctx,
      { subject: 'demo-official-osei', givenName: 'Kofi', familyName: 'Osei' },
      ['official'],
    ),
  };
  await optional(ctx, "the available official's availability", async () => {
    const availability = service(ctx, AvailabilityService);
    const mine = await availability.list(officials.nguyen.principal, {
      personId: officials.nguyen.personId,
      from: at(-60),
      to: at(180),
      includeWithdrawn: false,
    });
    if (mine.length > 0) return;
    await availability.create(
      officials.nguyen.principal,
      {
        interval: { start: at(-60), end: at(180) },
        kind: 'available',
        note: 'On site all morning',
        policyReferences: [],
      },
      null,
    );
  });

  // The two games at T0, each needing one accepted referee.
  const fixtureIds: string[] = [];
  const entry = (team: string): string | undefined => league.entries.get(team)?.id;
  const games: ReadonlyArray<{
    home: string;
    away: string;
    resourceId: string;
    referee: DemoAdult | null;
  }> = [
    {
      home: 'Desert Foxes',
      away: 'Neon City FC',
      resourceId: spaces.field2,
      referee: null,
    },
    {
      home: 'Red Rock Rovers',
      away: 'Mojave United',
      resourceId: spaces.field3,
      referee: staff.secondOfficial,
    },
  ];
  for (const game of games) {
    await optional(ctx, `the game ${game.home} vs ${game.away}`, async () => {
      const homeEntryId = entry(game.home);
      const awayEntryId = entry(game.away);
      if (!homeEntryId || !awayEntryId) return;
      const fixtures = service(ctx, FixturesService);
      const existing = (
        await fixtures.listForSeason(leagueManager, league.seasonId, { limit: 200 })
      ).items.find(
        (f) =>
          f.homeEntryId === homeEntryId &&
          f.awayEntryId === awayEntryId &&
          f.scheduledStart === at(0),
      );
      const fixtureId =
        existing?.id ??
        (
          await fixtures.create(
            leagueManager,
            {
              seasonId: league.seasonId,
              homeEntryId,
              awayEntryId,
              schedule: {
                facilityId: ctx.facilityId,
                resourceIds: [game.resourceId],
                scheduledStart: at(0),
                scheduledEnd: at(60),
                publish: true,
              },
              notes: 'Away coach asked for the east goal: low sun in the keeper’s eyes.',
              policyReferences: [],
            },
            null,
          )
        ).fixture.id;
      fixtureIds.push(fixtureId);
      if (existing) return;
      await settle(ctx);
      await refereeFor(ctx, leagueManager, fixtureId, game.referee);
      // Two more players per side (the rule set wants four eligible), and their answers.
      for (const [side, entryId] of [
        [game.home, homeEntryId],
        [game.away, awayEntryId],
      ] as const) {
        await topUpRoster(ctx, leagueManager, side, entryId, fixtureId);
      }
    });
  }
  await settle(ctx);
  return { t0: new Date(t0).toISOString(), fixtureIds };
}

const EXTRA_PLAYERS: ReadonlyArray<[string, string]> = [
  ['Maya', 'Ortiz'],
  ['Ella', 'Kim'],
  ['Ravi', 'Bose'],
  ['Ava', 'Lund'],
  ['Noah', 'Price'],
  ['Zoe', 'Hart'],
  ['Eli', 'Shaw'],
  ['Ines', 'Moro'],
];

/** Adds two players to a side and records answers for the game: going, not going, no answer. */
async function topUpRoster(
  ctx: DemoContext,
  by: Principal,
  team: string,
  entryId: string,
  fixtureId: string,
): Promise<void> {
  const offset = [...team].reduce((n, ch) => n + ch.charCodeAt(0), 0) % EXTRA_PLAYERS.length;
  const picks = [0, 1].map((i) => EXTRA_PLAYERS[(offset + i * 3) % EXTRA_PLAYERS.length]!);
  const adults = await seedAdults(
    ctx,
    picks.map(([givenName, familyName]) => ({
      key: `today-${team.split(' ')[0]!.toLowerCase()}-${givenName.toLowerCase()}`,
      givenName,
      familyName,
    })),
  );
  const players = [...adults.values()];
  await service(ctx, RosterService).changeRoster(
    by,
    entryId,
    {
      changes: players.map((p, i) => ({
        action: 'add' as const,
        personId: p.personId,
        status: 'active' as const,
        jerseyNumber: 10 + i,
      })),
      policyReferences: [],
    },
    null,
  );
  const fixtures = service(ctx, FixturesService);
  const states = ['available', 'unavailable'] as const;
  for (const [i, player] of players.entries()) {
    await optional(ctx, `an answer for ${team}`, () =>
      fixtures.recordAvailability(
        player.principal,
        fixtureId,
        { state: states[i % states.length]!, policyReferences: [] },
        null,
      ),
    );
  }
}

/** One referee required; offered to `referee`, who accepts (none: the slot stays open). */
async function refereeFor(
  ctx: DemoContext,
  by: Principal,
  fixtureId: string,
  referee: DemoAdult | null,
): Promise<void> {
  await service(ctx, RequirementsService).create(
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
  if (!referee) return;
  const assignments = service(ctx, AssignmentsService);
  const offered = await assignments.create(
    by,
    {
      personId: referee.personId,
      kind: 'official',
      role: 'referee',
      engagement: 'regular',
      targetType: 'fixture',
      targetId: fixtureId,
      offer: true,
      policyReferences: [],
    },
    null,
  );
  await assignments.accept(
    referee.principal,
    offered.assignment.id,
    { policyReferences: [] },
    null,
  );
}
