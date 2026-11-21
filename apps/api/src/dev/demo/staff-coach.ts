import type { CheckoutPayment, Offering, Principal } from '@sportspark/contracts';
import { UnitOfWork } from '../../kernel/database/unit-of-work';
import {
  OfferingsService,
  PoliciesService,
  PriceRulesService,
  ProgramsService,
  SessionsService,
  WaiversService,
  EntitlementDefinitionsService,
} from '../../modules/catalog';
import { BasketsService, EnrollmentsService } from '../../modules/enrollment';
import { YouthProgressionService } from '../../modules/enrollment/services/youth-progression.service';
import { AttendanceService } from '../../modules/entry';
import { CheckoutService, QuotesService } from '../../modules/finance';
import {
  ALL_PERMISSIONS,
  AuthorityReadsService,
  CareNotesService,
  HouseholdsService,
  PeopleService,
  RelationshipsService,
} from '../../modules/identity';
import {
  AssignmentsService,
  ReplacementsService,
  RequirementsService,
} from '../../modules/workforce';
import { WAIVER_KEY } from './catalog';
import {
  calendarOf,
  optional,
  principalOf,
  service,
  settle,
  soon,
  waitUntil,
  type DemoCalendar,
  type DemoContext,
} from './context';
import type { DemoStaff } from './people';

/**
 * The coach's and manager's screens as the redesign draws them (staff S 2d, S 3g, S 4d, S 5c,
 * S 5b, S 4e), built through the modules' own services like every demo stage, dated from the
 * seed's clock in the facility zone. Every name is invented and every number synthetic.
 *
 * - "Little Kickers": a class with one session running now (it started 12 minutes ago, 45
 *   minutes long, at "Court 1") and fourteen children, among them Leo and Maya Ortiz. The coach
 *   (the coach sign-in) holds the accepted assignment and has taken most of the attendance: nine
 *   here, one late, two absent, two still to mark. Noah has an allergy care note (Maya already has
 *   hers); the class requires the demo waiver, which Leo and Maya have not signed (a form flag).
 * - Leo can be collected by Dana (his parent), Carlos Ortiz (parent) and Rosa Ortiz (grandmother,
 *   pickup only): the adults the release screen shows.
 * - An approved end-of-term assessment template (Dribbling, Passing, Listening and teamwork on a
 *   three-level scale) with draft assessments for six children, and "Junior Skills 2" next term as
 *   the class to suggest.
 * - "Goalkeeper Basics" on Sunday 09:00-12:00: the coach declined it ("Family thing Sunday ...")
 *   and the manager proposed the second coach in his place (a swap waiting for approval); its
 *   referee slot is open (a requirement nobody covers yet).
 *
 * Every part is optional: a refusal is reported in the summary and the rest is still built.
 * Idempotent by names and titles. The session "now" is skipped when it would cross the facility's
 * midnight.
 */
export const COACH_DEMO = {
  kickers: 'Little Kickers',
  goalkeeper: 'Goalkeeper Basics',
  nextClass: 'Junior Skills 2',
  template: 'Little Kickers · end of term',
  swapNote: 'Family thing Sunday — Riley said he can cover.',
} as const;

const MINUTE = 60_000;

/** Children of the class, by household: [given name, age]. The Ortiz children come from the parent seed. */
const HOUSEHOLDS: ReadonlyArray<{
  family: string;
  adult: string;
  phone: string;
  children: ReadonlyArray<[string, number]>;
}> = [
  { family: 'Kim', adult: 'Grace', phone: '+17025550161', children: [['Ava', 6]] },
  { family: 'Tran', adult: 'Minh', phone: '+17025550162', children: [['Ben', 6]] },
  { family: 'Diaz', adult: 'Elena', phone: '+17025550163', children: [['Mia', 6]] },
  { family: 'Brooks', adult: 'Lena', phone: '+17025550164', children: [['Noah', 6]] },
  { family: 'Park', adult: 'Jae', phone: '+17025550165', children: [['Owen', 5]] },
  {
    family: 'Shah',
    adult: 'Anika',
    phone: '+17025550166',
    children: [
      ['Priya', 7],
      ['Sam', 5],
    ],
  },
  { family: 'Lee', adult: 'Hana', phone: '+17025550167', children: [['Quinn', 6]] },
  { family: 'Vega', adult: 'Marco', phone: '+17025550168', children: [['Theo', 7]] },
  {
    family: 'Fox',
    adult: 'Julia',
    phone: '+17025550169',
    children: [
      ['Uma', 6],
      ['Zara', 7],
    ],
  },
  { family: 'Cole', adult: 'Dev', phone: '+17025550170', children: [['Remy', 6]] },
];

/** The attendance the coach has taken: here, late, absent; the rest (Leo, Remy) unmarked. */
const HERE = ['Ava', 'Ben', 'Noah', 'Maya', 'Priya', 'Quinn', 'Sam', 'Theo', 'Uma'];
const LATE = ['Mia'];
const ABSENT = ['Owen', 'Zara'];
/** Children whose end-of-term assessment the coach has already drafted (6 of 14). */
const ASSESSED = ['Ava', 'Ben', 'Maya', 'Mia', 'Noah', 'Owen'];

interface Child {
  personId: string;
  givenName: string;
  guardianPersonId: string;
}

function localTime(timezone: string, at: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(at);
}

function localDate(timezone: string, at: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

export async function seedStaffCoach(ctx: DemoContext, staff: DemoStaff): Promise<void> {
  const calendar = calendarOf(ctx);
  const manager = staff.manager.principal;

  const people = await optional(ctx, 'the Little Kickers families', () =>
    ensureFamilies(ctx, calendar),
  );
  if (!people) return;
  const offerings = await optional(
    ctx,
    'Little Kickers, Goalkeeper Basics and Junior Skills 2',
    () => ensureOfferings(ctx, staff, calendar),
  );
  if (!offerings) return;

  const { kickers, kickersSessionId, goalkeeper, goalkeeperSessionId, nextClass } = offerings;
  if (kickers && kickersSessionId) {
    await optional(ctx, 'the Little Kickers registrations', () =>
      registerAll(ctx, staff.desk.principal, people.children, kickers.id),
    );
    await settle(ctx);
    await optional(ctx, 'the waiver Little Kickers requires', async () => {
      const waivers = service(ctx, WaiversService);
      // Every new child has it on paper; Leo and Maya Ortiz have not signed it (the form flag).
      for (const child of people.children) {
        if (['Leo', 'Maya'].includes(child.givenName)) continue;
        const status = await waivers.personWaivers(manager, child.personId);
        if (status.waivers.some((w) => w.policyKey === WAIVER_KEY && w.acceptance)) continue;
        await waivers.accept(
          staff.desk.principal,
          {
            subjectPersonId: child.personId,
            policyKey: WAIVER_KEY,
            method: 'paper',
            signedByPersonId: child.guardianPersonId,
            paperDatedOn: calendar.day(-12),
            evidence: { note: 'Signed on paper at the first class.' },
            policyReferences: [],
          },
          null,
        );
      }
      await waivers.setOfferingRequiredWaivers(
        manager,
        kickers.id,
        { policyKeys: [WAIVER_KEY], policyReferences: [] },
        null,
      );
    });
    const assigned = await optional(ctx, "the coach's Little Kickers assignment", () =>
      assignCoach(ctx, staff, kickers.id, kickersSessionId),
    );
    if (assigned) {
      await optional(ctx, "the coach's attendance so far", () =>
        recordAttendance(
          ctx,
          staff,
          people.children,
          kickers.id,
          kickersSessionId,
          offerings.start,
        ),
      );
      if (nextClass) {
        await optional(ctx, 'the end-of-term assessments', () =>
          assessments(ctx, staff, people.children, kickers, calendar),
        );
      }
    }
  }
  if (goalkeeper && goalkeeperSessionId) {
    await optional(ctx, 'the Sunday swap and open referee slot', () =>
      sundaySwap(ctx, staff, goalkeeper.id, goalkeeperSessionId),
    );
  }
  await settle(ctx);
}

async function ensureFamilies(
  ctx: DemoContext,
  calendar: DemoCalendar,
): Promise<{ children: Child[] }> {
  const peopleService = service(ctx, PeopleService);
  const reads = service(ctx, AuthorityReadsService);
  const households = service(ctx, HouseholdsService);
  const relationships = service(ctx, RelationshipsService);
  const uow = service(ctx, UnitOfWork);
  const year = Number(calendar.today.slice(0, 4));
  const grant = (
    actorPersonId: string,
    subjectPersonId: string,
    kind: 'guardian' | 'caregiver',
    permissions: typeof ALL_PERMISSIONS | Array<'view' | 'collect'>,
  ) =>
    uow.run(({ trx }) =>
      relationships.ensureAuthority(trx, ctx.system, ctx.organizationId, {
        actorPersonId,
        subjectPersonId,
        kind,
        permissions: [...permissions],
        source: 'staff',
        correlationId: null,
      }),
    );
  const findAdult = async (givenName: string, familyName: string): Promise<string | null> => {
    const found = await peopleService.searchPeople(ctx.system, {
      query: emailOf(givenName, familyName),
      kind: 'adult',
      limit: 10,
    });
    const match = found.items.find(
      (p) => p.givenName === givenName && p.familyName === familyName && p.kind === 'adult',
    );
    return match?.id ?? null;
  };
  const ensureAdult = async (
    givenName: string,
    familyName: string,
    phone: string,
  ): Promise<string> => {
    const known = await findAdult(givenName, familyName);
    if (known) return known;
    const created = await peopleService.createPerson(
      ctx.system,
      {
        kind: 'adult',
        givenName,
        familyName,
        dateOfBirth: `${year - 34}-05-20`,
        contactPoints: [
          {
            kind: 'email',
            value: emailOf(givenName, familyName),
            isPrimary: true,
            verified: true,
          },
          { kind: 'phone', value: phone, isPrimary: true, verified: true },
        ],
      },
      null,
    );
    return created.id;
  };

  const children: Child[] = [];
  for (const spec of HOUSEHOLDS) {
    const adult = await ensureAdult(spec.adult, spec.family, spec.phone);
    const authority = await reads.personAuthority(ctx.system, adult);
    const names = await peopleService.personNames(
      ctx.system,
      authority.grants.filter((g) => g.actorPersonId === adult).map((g) => g.subjectPersonId),
    );
    const mine: string[] = [];
    for (const [givenName, age] of spec.children) {
      const known = names.find((n) => n.givenName === givenName && n.familyName === spec.family);
      let personId = known?.personId ?? null;
      if (!personId) {
        const created = await peopleService.createPerson(
          ctx.system,
          {
            kind: 'child',
            givenName,
            familyName: spec.family,
            dateOfBirth: `${year - age - 1}-10-0${(age % 9) + 1}`,
            contactPoints: [],
          },
          null,
        );
        personId = created.id;
        await grant(adult, personId, 'guardian', ALL_PERMISSIONS);
        if (givenName === 'Noah') {
          await service(ctx, CareNotesService).record(
            ctx.system,
            personId,
            {
              kind: 'allergy',
              body: 'Tree nuts. Inhaler and adrenaline pen in the blue bag; call Lena at once.',
              policyReferences: [],
            },
            null,
          );
        }
      }
      mine.push(personId);
      children.push({ personId, givenName, guardianPersonId: adult });
    }
    if (!known(authority)) {
      const household = await households.createHousehold(
        ctx.system,
        { name: `${spec.family} household` },
        null,
      );
      for (const personId of [adult, ...mine]) {
        await households.addMember(ctx.system, household.id, { personId }, null);
      }
    }
  }

  // The Ortiz children (parent-core.ts) and the adults who may collect Leo and Maya.
  const dana = await principalOf(ctx, 'dev-parent');
  if (dana?.personId) {
    const authority = await reads.personAuthority(ctx.system, dana.personId);
    const names = await peopleService.personNames(
      ctx.system,
      authority.grants
        .filter((g) => g.actorPersonId === dana.personId)
        .map((g) => g.subjectPersonId),
    );
    const ortiz = ['Leo', 'Maya']
      .map((given) => names.find((n) => n.givenName === given && n.familyName === 'Ortiz'))
      .filter((n): n is NonNullable<typeof n> => n !== undefined);
    const carlos = await ensureAdult('Carlos', 'Ortiz', '+17025550171');
    const rosa = await ensureAdult('Rosa', 'Ortiz', '+17025550172');
    for (const child of ortiz) {
      children.push({
        personId: child.personId,
        givenName: child.givenName,
        guardianPersonId: dana.personId,
      });
      await grant(carlos, child.personId, 'guardian', ALL_PERMISSIONS);
      await grant(rosa, child.personId, 'caregiver', ['view', 'collect']);
    }
  }
  return { children };
}

const emailOf = (givenName: string, familyName: string): string =>
  `${givenName}.${familyName}@example.test`.toLowerCase();

/** A household already holds the adult when the adult has any household. */
function known(authority: { households: readonly unknown[] }): boolean {
  return authority.households.length > 0;
}

interface CoachOfferings {
  start: Date;
  kickers: Offering | null;
  kickersSessionId: string | null;
  goalkeeper: Offering | null;
  goalkeeperSessionId: string | null;
  nextClass: Offering | null;
}

async function ensureOfferings(
  ctx: DemoContext,
  staff: DemoStaff,
  calendar: DemoCalendar,
): Promise<CoachOfferings> {
  const manager = staff.manager.principal;
  const policies = service(ctx, PoliciesService);
  const programs = service(ctx, ProgramsService);
  const offeringsService = service(ctx, OfferingsService);
  const sessions = service(ctx, SessionsService);
  const priceRules = service(ctx, PriceRulesService);
  const policy = async (kind: 'eligibility' | 'cancellation', key: string): Promise<string> => {
    const found = await policies.list(manager, { kind, key, limit: 20 });
    const approved = found.items.find((v) => v.approvalStatus === 'approved');
    if (!approved) throw new Error(`no approved ${kind} policy ${key} in the demo catalog`);
    return approved.id;
  };
  const eligibility = await policy('eligibility', 'demo-open-eligibility');
  const cancellation = await policy('cancellation', 'demo-cancellation');
  const youth = (await programs.list(manager, { limit: 200 })).items.find(
    (p) => p.name === 'Youth soccer school',
  );
  if (!youth) throw new Error('the youth program of the demo catalog is missing');
  const listed = (await offeringsService.listForProgram(manager, youth.id, { limit: 200 })).items;
  const seat = (await service(ctx, EntitlementDefinitionsService).list(manager, {})).find(
    (d) => d.name === 'A place in a class or camp',
  )?.id;
  if (!seat) throw new Error('the seat entitlement of the demo catalog is missing');

  const ensure = async (spec: {
    name: string;
    label: string;
    startsOn: string;
    endsOn: string;
    sessions: Array<{ start: Date; end: Date }>;
    priceMinor: number;
  }): Promise<{ offering: Offering; sessionIds: string[] }> => {
    const existing = listed.find((o) => o.name === spec.name);
    if (existing) {
      const made = await sessions.list(manager, existing.id);
      return { offering: existing, sessionIds: made.map((s) => s.id) };
    }
    const created = await offeringsService.create(
      manager,
      {
        programId: youth.id,
        name: spec.name,
        description: 'Coach demo: a class the coach workspace shows.',
        kind: 'term',
        facilityId: ctx.facilityId,
        activityType: 'soccer',
        format: '5v5',
        location: { label: spec.label },
        startsOn: spec.startsOn,
        endsOn: spec.endsOn,
        registrationOpensAt: calendar.iso(-30, '09:00'),
        registrationClosesAt: calendar.iso(60, '21:00'),
        eligibilityPolicyVersionId: eligibility,
        entitlementDefinitionId: seat,
        capacityUnits: [{ unit: 'seats', limit: 16 }],
        requiredFormPolicyVersionIds: [],
        cancellationPolicyVersionId: cancellation,
        responsibleManagerPersonId: staff.manager.personId,
        policyReferences: [],
      },
      null,
    );
    const sessionIds: string[] = [];
    for (const s of spec.sessions) {
      const session = await sessions.create(
        manager,
        created.id,
        {
          scheduledStart: s.start.toISOString(),
          scheduledEnd: s.end.toISOString(),
          location: { label: spec.label },
          policyReferences: [],
        },
        null,
      );
      sessionIds.push(session.id);
    }
    const from = await soon(ctx);
    await priceRules.create(
      manager,
      created.id,
      {
        effectiveFrom: from,
        basePriceMinor: spec.priceMinor,
        currency: 'USD',
        chargeLines: [],
        pricingBasis: 'term',
        tiers: [],
        policyReferences: [],
      },
      null,
    );
    await waitUntil(ctx, from);
    await offeringsService.publish(manager, created.id, { policyReferences: [] }, null);
    await offeringsService.openRegistration(manager, created.id, { policyReferences: [] }, null);
    return { offering: created, sessionIds };
  };

  // Little Kickers: started 12 minutes ago (on a five-minute mark), 45 minutes long.
  const now = ctx.clock.now().getTime();
  const start = new Date(Math.floor((now - 12 * MINUTE) / (5 * MINUTE)) * 5 * MINUTE);
  const end = new Date(start.getTime() + 45 * MINUTE);
  const sameDay = localDate(ctx.timezone, start) === localDate(ctx.timezone, end);
  let kickers: { offering: Offering; sessionIds: string[] } | null = null;
  if (sameDay) {
    const day = localDate(ctx.timezone, start);
    kickers = await ensure({
      name: COACH_DEMO.kickers,
      label: 'Court 1',
      startsOn: day,
      endsOn: day,
      sessions: [{ start, end }],
      priceMinor: 9_000,
    });
  } else {
    ctx.log(`  Little Kickers now: ${localTime(ctx.timezone, start)} crosses midnight, skipped`);
  }

  // Goalkeeper Basics: Sunday of this week (or the next Sunday), 09:00-12:00 on Field 2.
  const sundayOffset = calendar.weekStart + 6 >= 0 ? calendar.weekStart + 6 : 6;
  const goalkeeper = await ensure({
    name: COACH_DEMO.goalkeeper,
    label: 'Field 2',
    startsOn: calendar.day(sundayOffset),
    endsOn: calendar.day(sundayOffset),
    sessions: [
      { start: calendar.at(sundayOffset, '09:00'), end: calendar.at(sundayOffset, '12:00') },
    ],
    priceMinor: 4_500,
  });

  // Junior Skills 2: next term, the class an assessment suggests.
  const nextClass = await ensure({
    name: COACH_DEMO.nextClass,
    label: 'Court 1',
    startsOn: calendar.day(45),
    endsOn: calendar.day(45 + 7 * 9),
    sessions: [
      { start: calendar.at(45, '09:15'), end: calendar.at(45, '10:00') },
      { start: calendar.at(52, '09:15'), end: calendar.at(52, '10:00') },
    ],
    priceMinor: 14_500,
  });

  // The session "now", found again by its start on a re-run.
  const kickersSession = kickers
    ? (await sessions.list(manager, kickers.offering.id)).find(
        (s) => s.status === 'scheduled' && new Date(s.scheduledEnd).getTime() > now,
      )
    : undefined;
  return {
    start: kickersSession ? new Date(kickersSession.scheduledStart) : start,
    kickers: kickers?.offering ?? null,
    kickersSessionId: kickersSession?.id ?? null,
    goalkeeper: goalkeeper.offering,
    goalkeeperSessionId: goalkeeper.sessionIds[0] ?? null,
    nextClass: nextClass.offering,
  };
}

/** One basket per household, at the desk, paid in cash; skipped for a child already placed. */
async function registerAll(
  ctx: DemoContext,
  desk: Principal,
  children: readonly Child[],
  offeringId: string,
): Promise<void> {
  const enrollments = service(ctx, EnrollmentsService);
  const baskets = service(ctx, BasketsService);
  const byGuardian = new Map<string, string[]>();
  for (const child of children) {
    const listed = await enrollments.list(desk, {
      participantPersonId: child.personId,
      offeringId,
      limit: 5,
    });
    if (listed.items.some((e) => e.status !== 'canceled')) continue;
    byGuardian.set(child.guardianPersonId, [
      ...(byGuardian.get(child.guardianPersonId) ?? []),
      child.personId,
    ]);
  }
  const cash: CheckoutPayment = {
    method: 'cash',
    tenderKind: 'cash',
    facilityId: ctx.facilityId,
    evidence: { reference: 'Till 1, Little Kickers' },
  };
  for (const [guardian, childIds] of byGuardian) {
    let basket = await baskets.create(
      desk,
      {
        ownerPersonId: guardian,
        fulfillmentMode: 'all_or_nothing',
        acceptPartialFulfillment: false,
        policyReferences: [],
      },
      null,
    );
    for (const participantPersonId of childIds) {
      basket = await baskets.addLine(
        desk,
        basket.id,
        { participantPersonId, offeringId, intent: 'youth', quantity: 1, policyReferences: [] },
        null,
      );
    }
    basket = await baskets.hold(
      desk,
      basket.id,
      { expectedRevision: basket.revision, policyReferences: [] },
      null,
    );
    const quote = await service(ctx, QuotesService).create(
      desk,
      {
        basketId: basket.id,
        discountCodes: [],
        creditIds: [],
        paymentPlan: { kind: 'full' },
        policyReferences: [],
      },
      null,
    );
    await service(ctx, CheckoutService).create(
      desk,
      {
        quoteId: quote.id,
        payment: cash,
        authorizeFutureInstallments: false,
        policyReferences: [],
      },
      null,
    );
    await settle(ctx);
  }
}

async function assignCoach(
  ctx: DemoContext,
  staff: DemoStaff,
  offeringId: string,
  sessionId: string,
): Promise<true> {
  const assignments = service(ctx, AssignmentsService);
  const existing = await assignments.list(staff.manager.principal, {
    targetType: 'session',
    targetId: sessionId,
    limit: 10,
    order: 'asc',
  });
  if (existing.items.some((a) => a.personId === staff.coach.personId)) return true;
  const created = await assignments.create(
    staff.manager.principal,
    {
      personId: staff.coach.personId,
      kind: 'coach',
      role: 'coach',
      engagement: 'regular',
      offer: true,
      targetType: 'session',
      targetId: sessionId,
      offeringId,
      policyReferences: [],
    },
    null,
  );
  await assignments.accept(
    staff.coach.principal,
    created.assignment.id,
    { policyReferences: [] },
    null,
  );
  return true;
}

async function recordAttendance(
  ctx: DemoContext,
  staff: DemoStaff,
  children: readonly Child[],
  offeringId: string,
  sessionId: string,
  start: Date,
): Promise<void> {
  const attendance = service(ctx, AttendanceService);
  const activity = { type: 'session' as const, offeringId, sessionId };
  const current = await attendance.attendance(staff.coach.principal, {
    activityType: 'session',
    activityId: sessionId,
    offeringId,
  });
  const recorded = new Set(
    current.people.filter((p) => p.history.length > 0).map((p) => p.personId),
  );
  const now = ctx.clock.now().getTime();
  const at = (minutes: number): string =>
    new Date(Math.min(start.getTime() + minutes * MINUTE, now - MINUTE)).toISOString();
  const mark = async (
    names: readonly string[],
    state: 'present' | 'late' | 'absent',
    minute: number,
  ) => {
    for (const child of children.filter((c) => names.includes(c.givenName))) {
      if (recorded.has(child.personId)) continue;
      await attendance.record(
        staff.coach.principal,
        {
          personId: child.personId,
          activity,
          observedState: state,
          observedAt: at(minute),
          policyReferences: [],
        },
        null,
      );
    }
  };
  await mark(HERE, 'present', 1);
  await mark(LATE, 'late', 5);
  await mark(ABSENT, 'absent', 8);
}

async function assessments(
  ctx: DemoContext,
  staff: DemoStaff,
  children: readonly Child[],
  kickers: Offering,
  calendar: DemoCalendar,
): Promise<void> {
  const youth = service(ctx, YouthProgressionService);
  const manager = staff.manager.principal;
  const templates = await youth.programTemplates(manager, kickers.programId, {});
  let template = templates.find((t) => t.name === COACH_DEMO.template) ?? null;
  if (!template) {
    template = await youth.createTemplate(
      manager,
      {
        programId: kickers.programId,
        name: COACH_DEMO.template,
        version: 1,
        skillAreas: [
          { key: 'dribbling', label: 'Dribbling' },
          { key: 'passing', label: 'Passing' },
          { key: 'listening_teamwork', label: 'Listening and teamwork' },
        ],
        scale: { kind: 'ordinal', levels: ['Starting', 'Getting it', 'Got it'] },
        policyReferences: [],
      },
      null,
    );
  }
  if (template.status === 'draft') {
    template = await youth.approveTemplate(
      manager,
      template.id,
      { expectedRevision: template.revision },
      null,
    );
  }
  const values: Record<string, [number, number, number, string]> = {
    Ava: [3, 2, 3, 'Ava listens first and is fearless on the ball.'],
    Ben: [2, 2, 3, 'Ben is a great team player. Next: using both feet.'],
    Maya: [3, 3, 2, 'Maya shoots with confidence. Next: waiting for her turn.'],
    Mia: [2, 1, 2, 'Mia is growing in confidence every week.'],
    Noah: [2, 3, 3, 'Noah passes beautifully and helps the younger ones.'],
    Owen: [1, 2, 2, 'Owen loves the games. Next: stopping the ball before he kicks.'],
  };
  const keys = ['dribbling', 'passing', 'listening_teamwork'] as const;
  for (const child of children.filter((c) => ASSESSED.includes(c.givenName))) {
    const existing = await youth.participantAssessments(staff.coach.principal, child.personId, {
      offeringId: kickers.id,
      limit: 20,
    });
    if (existing.items.length > 0) continue;
    const [d, p, l, note] = values[child.givenName] ?? [2, 2, 2, ''];
    for (const [i, value] of [d, p, l].entries()) {
      await youth.createAssessment(
        staff.coach.principal,
        {
          templateId: template.id,
          participantPersonId: child.personId,
          offeringId: kickers.id,
          skillAreaKey: keys[i] as string,
          observedOn: calendar.today,
          scaleValue: value,
          ...(i === 0 && note ? { comments: note } : {}),
          visibility: 'family',
          policyReferences: [],
        },
        null,
      );
    }
  }
}

async function sundaySwap(
  ctx: DemoContext,
  staff: DemoStaff,
  offeringId: string,
  sessionId: string,
): Promise<void> {
  const assignments = service(ctx, AssignmentsService);
  const manager = staff.manager.principal;
  const existing = await assignments.list(manager, {
    targetType: 'session',
    targetId: sessionId,
    limit: 10,
    order: 'asc',
  });
  if (existing.items.length === 0) {
    // The coach was offered the Sunday class and declined it with a note naming who can cover.
    const offered = await assignments.create(
      manager,
      {
        personId: staff.coach.personId,
        kind: 'coach',
        role: 'coach',
        engagement: 'regular',
        offer: true,
        targetType: 'session',
        targetId: sessionId,
        offeringId,
        policyReferences: [],
      },
      null,
    );
    await assignments.decline(
      staff.coach.principal,
      offered.assignment.id,
      { reason: COACH_DEMO.swapNote, policyReferences: [] },
      null,
    );
    // The manager proposed the second coach in his place: the swap waiting for approval.
    await service(ctx, ReplacementsService).replace(
      manager,
      offered.assignment.id,
      {
        personId: staff.secondCoach.personId,
        engagement: 'regular',
        offer: false,
        withdrawOriginal: false,
        reason: COACH_DEMO.swapNote,
        policyReferences: [],
      },
      null,
    );
  }
  // The referee slot nobody covers yet (an open shift).
  const requirements = service(ctx, RequirementsService);
  const listed = await requirements.list(manager, { targetType: 'session', targetId: sessionId });
  if (!listed.some((r) => r.kind === 'official')) {
    await requirements.create(
      manager,
      {
        targetType: 'session',
        targetId: sessionId,
        offeringId,
        kind: 'official',
        role: 'referee',
        requiredCount: 1,
        mustBeAccepted: true,
        requiredQualifications: [],
        policyReferences: [],
      },
      null,
    );
  }
}
