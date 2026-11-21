import type { Principal } from '@sportspark/contracts';
import { UnitOfWork } from '../../kernel/database/unit-of-work';
import { ApplicationsService, CapacityService, WaitlistService } from '../../modules/enrollment';
import { BookingsService } from '../../modules/enrollment/services/bookings.service';
import {
  ALL_PERMISSIONS,
  AuthorityReadsService,
  HouseholdsService,
  PeopleService,
  RelationshipAuthority,
  RelationshipsService,
} from '../../modules/identity';
import {
  ClosuresService,
  EventsService,
  ResourcesService,
  ScheduleDraftsService,
} from '../../modules/scheduling';
import type { DemoCatalog } from './catalog';
import { calendarOf, optional, service, settle, type DemoContext } from './context';
import { seedAdults, type DemoFamily, type DemoStaff } from './people';
import type { DemoSpaces } from './spaces';

/**
 * The staff schedule and registrations as the redesign draws them (S 1b day timeline, S 2b week by
 * use and "Find a free slot", S 5a regulars, S 1c triage queue, S 2c waitlist offers). Built
 * through the modules' own services, as the staff or families who would, dated from the seed's
 * clock in the facility zone (every part is synthetic):
 *
 * - today, a full day across the spaces from 08:00 to 22:00: league games and practices, program
 *   sessions on the court, rentals and a party;
 * - two open schedule drafts: a make-up game in a free hour, and a skills clinic that overlaps a
 *   rental (the conflict the "1 conflict" chip filters to);
 * - the other days of the week with a varied load, and a closure for a field repair tomorrow, so
 *   the week heatmap reads busy, quiet and closed days;
 * - a regular renter with weekly Saturday bookings (New booking's "Rents Field 1 south half most
 *   Saturdays");
 * - applications needing a decision for different reasons: three children just under the youth
 *   age band (one reason, so the bulk bar appears), one with no date of birth, beside the two
 *   eligible ones waiting for coach review;
 * - a place freed on the full class, so the waitlist's first family has an offer in flight.
 *
 * Every part is optional: a refusal (a clash with another part of the dataset on the day it runs)
 * is reported in the summary and the rest is still built. Idempotent by titles, names and starts.
 */
const PREFIX = 'Demo schedule: ';

interface Planned {
  title: string;
  kind: 'game' | 'practice' | 'session' | 'rental' | 'party' | 'pickup';
  resourceId: string;
  day: number;
  from: string;
  to: string;
  sport?: string | null;
}

export async function seedStaffSchedule(
  ctx: DemoContext,
  staff: DemoStaff,
  spaces: DemoSpaces,
  catalog: DemoCatalog,
  families: readonly DemoFamily[],
): Promise<void> {
  const manager = staff.manager.principal;
  const calendar = calendarOf(ctx);
  const events = service(ctx, EventsService);
  const resources = service(ctx, ResourcesService);

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
  const field4 = (await optional(ctx, 'Field 4', () => ensurePitch('Field 4'))) ?? null;

  // What already stands this week and next, so a re-run creates nothing twice.
  const from = calendar.iso(calendar.weekStart, '00:00');
  const to = calendar.iso(calendar.weekStart + 42, '00:00');
  const listed: {
    title: string;
    scheduledStart: string;
    scheduledEnd: string;
    status: string;
    resourceIds: string[];
  }[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10; page += 1) {
    const result = await events.listEvents(manager, {
      facilityId: ctx.facilityId,
      start: from,
      end: to,
      limit: 200,
      ...(cursor ? { cursor } : {}),
    });
    listed.push(...result.items);
    if (!result.nextCursor) break;
    cursor = result.nextCursor;
  }
  const has = (title: string, start: string): boolean =>
    listed.some((e) => e.title === title && e.scheduledStart === start && e.status !== 'canceled');
  // Spaces that hold the same ground (a pitch and its halves share conflict units).
  const units = new Map(known.map((r) => [r.id, r.conflictUnitIds]));
  const sameGround = (a: string, b: string): boolean =>
    a === b || (units.get(a) ?? []).some((u) => (units.get(b) ?? []).includes(u));
  const closures = service(ctx, ClosuresService);
  const closed = (await closures.listClosures(manager, ctx.facilityId)).filter(
    (c) => c.status === 'active' || c.status === 'pending',
  );
  /** Whether the ground is already held then (the dataset fits around what other parts built). */
  const busy = (resourceId: string, start: string, end: string): boolean => {
    const s = Date.parse(start);
    const e = Date.parse(end);
    const overlaps = (a: string, b: string) => Date.parse(a) < e && s < Date.parse(b);
    return (
      listed.some(
        (x) =>
          x.status !== 'canceled' &&
          overlaps(x.scheduledStart, x.scheduledEnd) &&
          x.resourceIds.some((id) => sameGround(id, resourceId)),
      ) ||
      closed.some(
        (c) =>
          (c.resourceId === null || sameGround(c.resourceId, resourceId)) &&
          overlaps(c.interval.start, c.interval.end),
      )
    );
  };

  const create = async (p: Planned): Promise<void> => {
    const start = calendar.iso(p.day, p.from);
    const end = calendar.iso(p.day, p.to);
    if (has(p.title, start) || busy(p.resourceId, start, end)) return;
    const created = await optional(ctx, `${p.title} (${calendar.day(p.day)} ${p.from})`, () =>
      events.createEvent(manager, {
        facilityId: ctx.facilityId,
        kind: p.kind,
        title: p.title,
        sport: p.sport === undefined ? (p.kind === 'party' ? null : 'soccer') : p.sport,
        scheduledStart: start,
        scheduledEnd: calendar.iso(p.day, p.to),
        resourceIds: [p.resourceId],
        sourceType: 'manual',
        sourceId: ctx.facilityId,
        status: 'published',
        reason: `${PREFIX}the day timeline and the week by use`,
      }),
    );
    if (created) listed.push(created);
  };

  // Today: a full day on every space.
  const today: Planned[] = [
    {
      title: 'U12 Strikers training',
      kind: 'practice',
      resourceId: spaces.field1,
      day: 0,
      from: '08:00',
      to: '09:00',
    },
    {
      title: 'U14 Div A scrimmage',
      kind: 'practice',
      resourceId: spaces.field1,
      day: 0,
      from: '09:00',
      to: '11:00',
    },
    {
      title: 'Kowalski rental',
      kind: 'rental',
      resourceId: spaces.field1,
      day: 0,
      from: '11:30',
      to: '13:00',
    },
    {
      title: 'Adult 7v7 league night',
      kind: 'game',
      resourceId: spaces.field1,
      day: 0,
      from: '19:00',
      to: '21:00',
    },
    {
      title: 'Desert Foxes v Lions',
      kind: 'game',
      resourceId: spaces.field2,
      day: 0,
      from: '09:00',
      to: '10:00',
    },
    {
      title: 'Comets v Hawks',
      kind: 'game',
      resourceId: spaces.field2,
      day: 0,
      from: '10:00',
      to: '11:00',
    },
    {
      title: 'Ballers v Neon',
      kind: 'game',
      resourceId: spaces.field2,
      day: 0,
      from: '19:00',
      to: '20:00',
    },
    {
      title: 'Red Rocks v Comets',
      kind: 'game',
      resourceId: spaces.field3,
      day: 0,
      from: '09:00',
      to: '10:00',
    },
    {
      title: 'Lee rental',
      kind: 'rental',
      resourceId: spaces.field3,
      day: 0,
      from: '12:00',
      to: '13:30',
    },
    {
      title: 'Thursday Coed 7v7',
      kind: 'game',
      resourceId: spaces.field3,
      day: 0,
      from: '20:00',
      to: '21:00',
    },
    {
      title: 'Open gym',
      kind: 'pickup',
      resourceId: spaces.court,
      day: 0,
      from: '08:00',
      to: '09:00',
    },
    {
      title: 'Little Kickers',
      kind: 'session',
      resourceId: spaces.court,
      day: 0,
      from: '09:15',
      to: '10:00',
    },
    {
      title: 'Junior Skills',
      kind: 'session',
      resourceId: spaces.court,
      day: 0,
      from: '11:00',
      to: '11:45',
    },
    {
      title: 'Junior Hoops',
      kind: 'session',
      resourceId: spaces.court,
      day: 0,
      from: '12:00',
      to: '13:30',
      sport: 'basketball',
    },
    {
      title: 'Late drop-in',
      kind: 'pickup',
      resourceId: spaces.court,
      day: 0,
      from: '20:30',
      to: '22:00',
    },
    {
      title: 'Chen party',
      kind: 'party',
      resourceId: spaces.partyRoom,
      day: 0,
      from: '15:00',
      to: '17:00',
    },
  ];
  for (const p of today) await create(p);

  // The rest of this week and the next: a varied load, so the heatmap has quiet and full days.
  const load: Array<Omit<Planned, 'day'>> = [
    {
      title: 'Evening league',
      kind: 'game',
      resourceId: spaces.field1,
      from: '18:00',
      to: '21:00',
    },
    {
      title: 'Morning clinic',
      kind: 'session',
      resourceId: spaces.field2,
      from: '09:00',
      to: '11:00',
    },
    {
      title: 'Youth basketball',
      kind: 'session',
      resourceId: spaces.court,
      from: '16:00',
      to: '19:00',
      sport: 'basketball',
    },
    {
      title: 'Weekend rental',
      kind: 'rental',
      resourceId: spaces.field3,
      from: '12:00',
      to: '14:00',
    },
    {
      title: 'Adult pickup',
      kind: 'pickup',
      resourceId: spaces.field2,
      from: '19:00',
      to: '21:00',
    },
    {
      title: 'Birthday party',
      kind: 'party',
      resourceId: spaces.partyRoom,
      from: '13:00',
      to: '15:00',
    },
    {
      title: 'Afternoon practice',
      kind: 'practice',
      resourceId: spaces.field3,
      from: '15:00',
      to: '18:00',
    },
    { title: 'Lunch league', kind: 'game', resourceId: spaces.field1, from: '12:00', to: '14:00' },
    {
      title: 'Morning training',
      kind: 'practice',
      resourceId: spaces.field3,
      from: '07:00',
      to: '09:00',
    },
    {
      title: 'After-school hoops',
      kind: 'session',
      resourceId: spaces.court,
      from: '19:00',
      to: '22:00',
      sport: 'basketball',
    },
  ];
  for (let offset = calendar.weekStart; offset < calendar.weekStart + 14; offset += 1) {
    if (offset === 0) continue;
    const date = calendar.day(offset);
    const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
    const weekend = weekday === 0 || weekday === 6;
    // 4 to 10 activities a day, more at weekends; the same day of the week gets the same load.
    const count = weekend ? load.length : 4 + ((weekday * 2) % 6);
    for (const item of load.slice(0, count)) {
      if (!weekend && item.kind === 'party') continue;
      await create({ ...item, day: offset });
    }
  }

  // Tomorrow, Field 4 is closed all day for a repair (hatched on the week).
  if (field4) {
    await optional(ctx, 'the Field 4 repair closure tomorrow', async () => {
      const existing = await closures.listClosures(manager, ctx.facilityId);
      const start = calendar.iso(1, '00:00');
      if (existing.some((c) => c.resourceId === field4 && c.interval.start === start)) return;
      if (busy(field4, start, calendar.iso(2, '00:00'))) return;
      const closure = await closures.createClosure(manager, {
        facilityId: ctx.facilityId,
        resourceId: field4,
        interval: { start, end: calendar.iso(2, '00:00') },
        reason: 'Field 4 repair',
        source: 'manual',
      });
      await closures.applyClosure(manager, closure.id, { mode: 'cancel_affected' });
    });
  }

  // Two open drafts on today's grid: a make-up in a free hour and a clinic that overlaps a rental.
  const drafts = service(ctx, ScheduleDraftsService);
  const openDrafts = await drafts.list(manager, ctx.facilityId);
  const draft = async (
    name: string,
    title: string,
    kind: Planned['kind'],
    resourceId: string,
    fromTime: string,
    toTime: string,
  ) => {
    if (
      openDrafts.some(
        (d) => d.name === name && d.status !== 'discarded' && d.status !== 'published',
      )
    )
      return;
    await optional(ctx, `the draft ${name}`, () =>
      drafts.create(manager, {
        facilityId: ctx.facilityId,
        name,
        changes: [
          {
            kind: 'create',
            proposed: {
              kind,
              title,
              sport: 'soccer',
              scheduledStart: calendar.iso(0, fromTime),
              scheduledEnd: calendar.iso(0, toTime),
              sourceType: 'manual',
              sourceId: ctx.facilityId,
            },
            resourceIds: [resourceId],
          },
        ],
      }),
    );
  };
  await draft('Make-up: Comets v Hawks', 'Make-up', 'game', spaces.field2, '11:00', '12:00');
  await draft('Skills clinic', 'Skills clinic', 'session', spaces.field3, '11:00', '12:30');

  // A regular renter: Saturdays on Field 3 for four weeks (from the next Saturday).
  await optional(ctx, 'the regular Saturday rental', async () => {
    const renters = await seedAdults(ctx, [
      { key: 'renter-regular', givenName: 'Luis', familyName: 'Garcia-Sample' },
    ]);
    const renter = renters.get('renter-regular');
    if (!renter) return;
    const bookings = service(ctx, BookingsService);
    const mine = await bookings.list(staff.desk.principal, {
      facilityId: ctx.facilityId,
      kind: 'rental',
      limit: 200,
    });
    if (mine.items.some((b) => b.bookerPersonId === renter.personId)) return;
    const weekday = new Date(`${calendar.today}T12:00:00Z`).getUTCDay();
    const saturday = ((6 - weekday + 7) % 7) + 7;
    const weeks = [0, 1, 2].map((w) => saturday + w * 7);
    if (
      weeks.some((d) =>
        busy(spaces.field1South, calendar.iso(d, '15:00'), calendar.iso(d, '16:30')),
      )
    ) {
      return;
    }
    await bookings.create(
      staff.desk.principal,
      {
        offeringId: catalog.rental.id,
        bookerPersonId: renter.personId,
        start: calendar.iso(saturday, '15:00'),
        end: calendar.iso(saturday, '16:30'),
        recurrence: { interval: 1, count: 3 },
        resourceIds: [spaces.field1South],
        policyReferences: [],
      },
      null,
    );
  });
  await settle(ctx);

  await seedDecisions(ctx, staff, catalog, families);
  await settle(ctx);
}

/**
 * Applications needing a decision (S 1c) and an offer in flight (S 2c). Children just under the
 * youth age band are added to three households with their dates of birth (a few weeks to months
 * before their fifth birthday), and one without a date of birth, then their parents apply to the
 * advanced squad: eligibility fails for them, so each waits for a decision with its reason.
 */
async function seedDecisions(
  ctx: DemoContext,
  staff: DemoStaff,
  catalog: DemoCatalog,
  families: readonly DemoFamily[],
): Promise<void> {
  const manager = staff.manager.principal;
  const calendar = calendarOf(ctx);
  const kids: Array<{ family: string; givenName: string; dob: string | null }> = [
    { family: 'birch', givenName: 'Noah', dob: fifthBirthdayIn(calendar.today, 4, 4) },
    { family: 'cedar', givenName: 'Ava', dob: fifthBirthdayIn(calendar.today, 5, 20) },
    { family: 'dune', givenName: 'Leo', dob: fifthBirthdayIn(calendar.today, 6, 2) },
    { family: 'grove', givenName: 'Elena', dob: null },
  ];
  const people = service(ctx, PeopleService);
  const applications = service(ctx, ApplicationsService);
  for (const kid of kids) {
    const family = families.find((f) => f.key === kid.family);
    if (!family) continue;
    await optional(ctx, `the application of ${kid.givenName}`, async () => {
      const familyName =
        (await people.personNames(ctx.system, [family.adult.personId]))[0]?.familyName ?? 'Sample';
      const authorities = await service(ctx, RelationshipAuthority).authoritiesOf(
        ctx.organizationId,
        family.adult.personId,
      );
      const names = await people.personNames(
        ctx.system,
        authorities.map((a) => a.subjectPersonId),
      );
      let childId = names.find((n) => n.givenName === kid.givenName)?.personId;
      if (!childId) {
        const child = await people.createPerson(
          ctx.system,
          {
            kind: 'child',
            givenName: kid.givenName,
            familyName,
            ...(kid.dob ? { dateOfBirth: kid.dob } : {}),
            contactPoints: [],
          },
          null,
        );
        childId = child.id;
        await service(ctx, UnitOfWork).run(({ trx }) =>
          service(ctx, RelationshipsService).ensureAuthority(trx, ctx.system, ctx.organizationId, {
            actorPersonId: family.adult.personId,
            subjectPersonId: child.id,
            kind: 'guardian',
            permissions: ALL_PERMISSIONS,
            source: 'staff',
            correlationId: null,
          }),
        );
        const households = await service(ctx, AuthorityReadsService).myHouseholds(
          family.adult.principal,
        );
        const household = households[0];
        if (household) {
          await service(ctx, HouseholdsService).addMember(
            ctx.system,
            household.id,
            { personId: child.id },
            null,
          );
        }
      }
      const listed = await applications.list(manager, {
        offeringId: catalog.approvalClass.id,
        participantPersonId: childId,
        limit: 10,
      });
      if (listed.items.length > 0) return;
      await applications.create(
        family.adult.principal as Principal,
        {
          offeringId: catalog.approvalClass.id,
          participantPersonId: childId,
          intent: 'youth',
          notes: 'Plays with an older sibling; would like to join this season.',
          policyReferences: [],
        },
        null,
      );
    });
  }

  // A place frees up on the full class: the queue offers it to the first family waiting.
  await optional(ctx, 'the waitlist offer in flight', async () => {
    const waitlist = service(ctx, WaitlistService);
    const entries = await waitlist.list(manager, { offeringId: catalog.smallClass.id });
    if (entries.some((e) => e.status === 'offered')) return;
    const capacity = service(ctx, CapacityService);
    const pools = await capacity.listPools(manager, { offeringId: catalog.smallClass.id });
    const pool = pools.find((p) => p.scopeType === 'offering') ?? pools[0];
    if (!pool) return;
    await capacity.adjustPool(
      manager,
      pool.id,
      {
        capacity: pool.capacity + 1,
        reason: 'Demo dataset: a second coach joins, one more place',
        expectedRevision: pool.revision,
        policyReferences: [],
      },
      null,
    );
  });
}

/** A date of birth whose fifth birthday falls on `day` of the month `months` from today. */
function fifthBirthdayIn(today: string, months: number, day: number): string {
  const [y, m] = today.split('-').map(Number) as [number, number];
  const at = new Date(Date.UTC(y - 5, m - 1 + months, day));
  return at.toISOString().slice(0, 10);
}
