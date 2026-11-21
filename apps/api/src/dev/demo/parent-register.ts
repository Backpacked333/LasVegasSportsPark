import type { CheckoutPayment, Offering, Principal } from '@sportspark/contracts';
import {
  DiscountsService,
  EntitlementDefinitionsService,
  OfferingExtrasService,
  OfferingsService,
  PoliciesService,
  PriceRulesService,
  ProgramsService,
  SessionsService,
  WaiversService,
} from '../../modules/catalog';
import {
  BasketsService,
  CapacityService,
  EnrollmentsService,
  WaitlistService,
} from '../../modules/enrollment';
import { CheckoutService, FakePaymentTokens, QuotesService } from '../../modules/finance';
import { EventSeriesService, EventsService, ResourcesService } from '../../modules/scheduling';
import { WAIVER_KEY } from './catalog';
import {
  calendarOf,
  requirePrincipal,
  service,
  settle,
  soon,
  waitUntil,
  type DemoCalendar,
  type DemoContext,
} from './context';
import { gameStart } from './parent-core';
import type { DemoFamily, DemoStaff } from './people';

/**
 * Explore and registration as the parent-app redesign draws them (handoff M 1d, 3d, 1e, 2a, 1f,
 * 1g, 2e; BUILD_PLAN Phase 2; ADR-007 synthetic data), through the modules' own services:
 *
 * - **Winter Break Camp**, four camp weeks of one program (the camp's weeks on Options, 2a): week 1
 *   nearly full (3 places left), week 2 open, week 3 full (its places taken by other demo
 *   families), week 4 not open for registration yet; a "Multi-week" automatic discount for two
 *   weeks or more (the floodlight tag on Explore and the price bar's "applied" line).
 * - **Spring Rec League · U9**, Saturdays for ten weeks, with an "Early bird" automatic discount,
 *   a promo code `FRIENDS12` ($12 off, Review's code field), a required uniform (the size on the
 *   Review line) and a "Photo consent" form (signed on Review before paying).
 * - **Futsal Skills Clinic** (Wednesdays, fits Maya's week, 4 places) and **Junior Hoops**
 *   (weekly from today at the time of Maya's game, so it clashes with Desert Foxes).
 * - **Goalkeeper Basics**, one place taken by another family; Maya joins its waitlist and a place
 *   is then offered to her (the waitlist offer, 2e, with the API's offer deadline).
 *
 * Two spaces of its own ("Court 2" and "Field 5") keep these sessions clear of the other stages'
 * bookings. Idempotent: everything is found by name (or by the participant) before it is made.
 * Prices, capacities and wording are sample values, never policy defaults.
 */
export const CAMP_PROGRAM = 'Winter Break Camp';
export const LEAGUE_OFFERING = 'Spring Rec League · U9';
export const FUTSAL_OFFERING = 'Futsal Skills Clinic';
export const HOOPS_OFFERING = 'Junior Hoops';
export const GOALKEEPER_OFFERING = 'Goalkeeper Basics';
export const PROMO_CODE = 'FRIENDS12';
const PHOTO_CONSENT_KEY = 'demo-photo-consent';

interface Plan {
  frequency: 'weekly' | 'daily';
  firstDay: number;
  count: number;
  time: string;
  minutes: number;
  resourceId: string;
}

interface Spec {
  programId: string;
  name: string;
  description: string;
  kind: Offering['kind'];
  activityType: string;
  format: string;
  locationLabel: string;
  startsOn: string;
  endsOn: string;
  seats: number;
  priceMinor: number;
  plan: Plan;
  /** Registration opens later (the closed camp week): published, not opened. */
  opensInDays?: number;
  formIds?: string[];
}

export async function seedParentRegister(
  ctx: DemoContext,
  staff: DemoStaff,
  families: readonly DemoFamily[],
  devChildPersonId: string,
): Promise<void> {
  const manager = staff.manager.principal;
  const calendar = calendarOf(ctx);
  const policies = service(ctx, PoliciesService);
  const programs = service(ctx, ProgramsService);
  const offerings = service(ctx, OfferingsService);
  const priceRules = service(ctx, PriceRulesService);
  const sessions = service(ctx, SessionsService);
  const series = service(ctx, EventSeriesService);
  const events = service(ctx, EventsService);
  const extras = service(ctx, OfferingExtrasService);
  const waivers = service(ctx, WaiversService);
  const discounts = service(ctx, DiscountsService);
  const resources = service(ctx, ResourcesService);

  const approved = async (kind: 'eligibility' | 'cancellation', key: string): Promise<string> => {
    const found = await policies.list(manager, { kind, key, limit: 20 });
    const version = found.items.find((v) => v.approvalStatus === 'approved');
    if (!version) throw new Error(`no approved ${kind} policy ${key} in the demo catalog`);
    return version.id;
  };
  const eligibility = await approved('eligibility', 'demo-open-eligibility');
  const cancellation = await approved('cancellation', 'demo-cancellation');
  const seat = (await service(ctx, EntitlementDefinitionsService).list(manager, {})).find(
    (d) => d.name === 'A place in a class or camp',
  )?.id;
  if (!seat) throw new Error('the seat entitlement of the demo catalog is missing');

  // The photo consent form the league asks for (signed on Review before paying).
  const forms = await policies.list(manager, { kind: 'form', key: PHOTO_CONSENT_KEY, limit: 10 });
  let photoConsent = forms.items.find((v) => v.approvalStatus === 'approved')?.id ?? null;
  if (!photoConsent) {
    const draft =
      forms.items.find((v) => v.approvalStatus === 'draft') ??
      (await policies.createPolicyVersion(
        manager,
        {
          kind: 'form',
          key: PHOTO_CONSENT_KEY,
          title: 'Photo consent',
          content: {
            text: 'Sample wording for the demo. The league may take team photos at games and show them in the park and in the app. You can ask the front desk to leave your child out at any time.',
          },
          effectiveFrom: calendar.iso(-60, '00:00'),
          policyReferences: [],
        },
        null,
      ));
    await policies.approve(manager, draft.id, { policyReferences: [] }, null);
    photoConsent = draft.id;
  }

  // Spaces of this stage only, so nothing here collides with another stage's bookings.
  const listedSpaces = await resources.listResources(manager, ctx.facilityId);
  const space = async (name: string, kind: 'pitch' | 'other'): Promise<string> =>
    listedSpaces.find((r) => r.name === name)?.id ??
    (
      await resources.createResource(manager, {
        facilityId: ctx.facilityId,
        name,
        kind,
        compatibleFormats: ['7v7', '5v5', 'indoor_boarded'],
        defaultSetupMinutes: 0,
        defaultCleanupMinutes: 0,
        policyReferences: [],
      })
    ).id;
  const court2 = await space('Court 2', 'other');
  const field5 = await space('Field 5', 'pitch');

  const knownPrograms = (await programs.list(manager, { limit: 200 })).items;
  const program = async (
    name: string,
    activityType: string,
    ageBand: { minAgeYears: number; maxAgeYears: number },
    description: string,
  ): Promise<string> =>
    knownPrograms.find((p) => p.name === name)?.id ??
    (
      await programs.create(
        manager,
        {
          name,
          description,
          activityType,
          format: '5v5',
          ageBand,
          status: 'active',
          policyReferences: [],
        },
        null,
      )
    ).id;
  const campProgram = await program(
    CAMP_PROGRAM,
    'soccer',
    { minAgeYears: 5, maxAgeYears: 12 },
    'Full days of games and skills over the winter break, week by week.',
  );
  const leagueProgram = await program(
    'Spring Rec League',
    'soccer',
    { minAgeYears: 7, maxAgeYears: 9 },
    'Saturday recreational soccer, placed on teams by age.',
  );
  const skillsProgram = await program(
    'After-school skills',
    'soccer',
    { minAgeYears: 6, maxAgeYears: 12 },
    'Small-group clinics after school.',
  );

  const offeringsOf = new Map<string, Offering[]>();
  const ensure = async (spec: Spec): Promise<Offering> => {
    let listed = offeringsOf.get(spec.programId);
    if (!listed) {
      listed = (await offerings.listForProgram(manager, spec.programId, { limit: 200 })).items;
      offeringsOf.set(spec.programId, listed);
    }
    const known = listed.find((o) => o.name === spec.name);
    if (known) return known;
    const created = await offerings.create(
      manager,
      {
        programId: spec.programId,
        name: spec.name,
        description: spec.description,
        kind: spec.kind,
        facilityId: ctx.facilityId,
        activityType: spec.activityType,
        format: spec.format,
        location: { label: spec.locationLabel, resourceIds: [spec.plan.resourceId] },
        startsOn: spec.startsOn,
        endsOn: spec.endsOn,
        registrationOpensAt: calendar.iso(spec.opensInDays ?? -14, '09:00'),
        registrationClosesAt: calendar.iso(60, '21:00'),
        eligibilityPolicyVersionId: eligibility,
        entitlementDefinitionId: seat,
        capacityUnits: [{ unit: 'seats', limit: spec.seats }],
        requiredFormPolicyVersionIds: spec.formIds ?? [],
        cancellationPolicyVersionId: cancellation,
        responsibleManagerPersonId: staff.manager.personId,
        policyReferences: [],
      },
      null,
    );
    const made = await series.createSeries(manager, {
      facilityId: ctx.facilityId,
      kind: 'session',
      title: spec.name,
      sport: spec.activityType,
      recurrence: {
        frequency: spec.plan.frequency,
        interval: 1,
        startDate: calendar.day(spec.plan.firstDay),
        count: spec.plan.count,
      },
      localStartTime: spec.plan.time,
      durationMinutes: spec.plan.minutes,
      resourceIds: [spec.plan.resourceId],
      commitments: [],
      sourceType: 'offering',
      sourceId: created.id,
      policyReferences: [],
    });
    const occurrences = [];
    for (const eventId of made.eventIds) occurrences.push(await events.getEvent(manager, eventId));
    occurrences.sort((a, b) => a.scheduledStart.localeCompare(b.scheduledStart));
    for (const event of occurrences) {
      await sessions.create(
        manager,
        created.id,
        {
          scheduledStart: event.scheduledStart,
          scheduledEnd: event.scheduledEnd,
          schedulingEventId: event.id,
          policyReferences: [],
        },
        null,
      );
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
    if (spec.kind === 'camp') {
      // The extras of Options (2a): sold per day, for the days the child attends.
      for (const addon of [
        {
          code: 'early_drop_off',
          name: 'Early drop-off · 7:30 AM',
          description: 'Supervised from 7:30 AM.',
          priceMinor: 1_000,
        },
        {
          code: 'hot_lunch',
          name: 'Hot lunch',
          description: 'A hot lunch each day.',
          priceMinor: 800,
        },
      ]) {
        await extras.createAddon(
          manager,
          created.id,
          {
            ...addon,
            selection: 'per_session',
            currency: 'USD',
            chargeLines: [],
            policyReferences: [],
          },
          null,
        );
      }
    }
    if (spec.name === LEAGUE_OFFERING) {
      await extras.createUniform(
        manager,
        created.id,
        {
          itemKey: 'rec-league-kit',
          name: 'Uniform',
          sizes: ['Youth S', 'Youth M', 'Youth L'],
          requirement: 'required',
          priceMinor: 2_500,
          currency: 'USD',
          chargeLines: [],
          returningHolderFree: false,
          policyReferences: [],
        },
        null,
      );
    }
    await waitUntil(ctx, from);
    await waivers.setOfferingRequiredWaivers(
      manager,
      created.id,
      { policyKeys: [WAIVER_KEY], policyReferences: [] },
      null,
    );
    await offerings.publish(manager, created.id, { policyReferences: [] }, null);
    if (spec.opensInDays === undefined) {
      await offerings.openRegistration(manager, created.id, { policyReferences: [] }, null);
    }
    // The places left Explore shows ("3 left") are read from the offering's capacity pools.
    await service(ctx, CapacityService).syncOfferingPools(
      manager,
      created.id,
      { policyReferences: [] },
      null,
    );
    listed.push(created);
    return created;
  };

  // Winter Break Camp: four Monday-to-Friday weeks, five weeks from now.
  const campStart = calendar.weekStart + 35;
  const weekSeats = [4, 9, 2, 12];
  const campWeeks: Offering[] = [];
  for (const [index, seats] of weekSeats.entries()) {
    const first = campStart + index * 7;
    campWeeks.push(
      await ensure({
        programId: campProgram,
        name: `${CAMP_PROGRAM} · Week ${index + 1}`,
        description:
          'Games, skills and a Friday mini tournament, 9 to 3 each day. Bring a water bottle and a packed snack.',
        kind: 'camp',
        activityType: 'soccer',
        format: '5v5',
        locationLabel: 'Field 5',
        startsOn: calendar.day(first),
        endsOn: calendar.day(first + 4),
        seats,
        priceMinor: 14_500,
        plan: {
          frequency: 'daily',
          firstDay: first,
          count: 5,
          time: '09:00',
          minutes: 360,
          resourceId: field5,
        },
        // Week 4 opens for registration later (Options shows it closed, with its opening date).
        ...(index === 3 ? { opensInDays: 10 } : {}),
      }),
    );
  }

  // Spring Rec League · U9: ten Saturdays from the Saturday three weeks ahead.
  const saturday = calendar.weekStart + 5 + 21;
  const league = await ensure({
    programId: leagueProgram,
    name: LEAGUE_OFFERING,
    description:
      'Recreational 7v7 on Saturday mornings. Players are placed on teams by age before the first game.',
    kind: 'season',
    activityType: 'soccer',
    format: '7v7',
    locationLabel: 'Field 5',
    startsOn: calendar.day(saturday),
    endsOn: calendar.day(saturday + 63),
    seats: 60,
    priceMinor: 12_000,
    plan: {
      frequency: 'weekly',
      firstDay: saturday,
      count: 10,
      time: '09:00',
      minutes: 60,
      resourceId: field5,
    },
    formIds: [photoConsent],
  });

  // Junior Hoops: weekly from today at the time of Maya's game, so it clashes with Desert Foxes.
  const game = gameStart(ctx);
  const hoops = await ensure({
    programId: skillsProgram,
    name: HOOPS_OFFERING,
    description: 'Dribbling, passing and a short game at the end. Six weeks.',
    kind: 'term',
    activityType: 'basketball',
    format: '3v3',
    locationLabel: 'Court 2 · Indoor',
    startsOn: calendar.day(game.days),
    endsOn: calendar.day(game.days + 35),
    seats: 12,
    priceMinor: 11_000,
    plan: {
      frequency: 'weekly',
      firstDay: game.days,
      count: 6,
      time: game.time,
      minutes: 60,
      resourceId: court2,
    },
  });

  // Futsal Skills Clinic: Wednesdays at 5 PM for eight weeks (Tuesdays when Hoops takes that hour).
  const weekdayOf = (days: number) => new Date(`${calendar.day(days)}T12:00:00Z`).getUTCDay();
  let futsalDay = calendar.weekStart + 9; // next Wednesday
  if (weekdayOf(game.days) === 3 && game.time === '17:00') futsalDay -= 1;
  const futsal = await ensure({
    programId: skillsProgram,
    name: FUTSAL_OFFERING,
    description:
      'Fast footwork and close control on the indoor court. Small groups, lots of touches, a mini tournament in the last week.',
    kind: 'term',
    activityType: 'futsal',
    format: '5v5',
    locationLabel: 'Court 2 · Indoor',
    startsOn: calendar.day(futsalDay),
    endsOn: calendar.day(futsalDay + 49),
    seats: 4,
    priceMinor: 9_500,
    plan: {
      frequency: 'weekly',
      firstDay: futsalDay,
      count: 8,
      time: '17:00',
      minutes: 60,
      resourceId: court2,
    },
  });

  // Goalkeeper Basics: four Sundays, one place.
  const sunday = calendar.weekStart + 6 + 14;
  const goalkeeper = await ensure({
    programId: skillsProgram,
    name: GOALKEEPER_OFFERING,
    description: 'Diving, positioning and distribution for young keepers. Four Sunday mornings.',
    kind: 'term',
    activityType: 'soccer',
    format: '5v5',
    locationLabel: 'Field 5',
    startsOn: calendar.day(sunday),
    endsOn: calendar.day(sunday + 21),
    seats: 1,
    priceMinor: 6_000,
    plan: {
      frequency: 'weekly',
      firstDay: sunday,
      count: 4,
      time: '09:00',
      minutes: 60,
      resourceId: field5,
    },
  });
  void futsal;
  void hoops;

  // Discounts: the camp's multi-week discount, the league's early bird and its promo code.
  const existing = (await discounts.list(manager, { limit: 100 })).items;
  const discount = async (body: Parameters<DiscountsService['create']>[1]): Promise<void> => {
    if (existing.some((d) => d.name === body.name)) return;
    await discounts.create(manager, body, null);
  };
  await discount({
    name: 'Multi-week',
    description: 'Two camp weeks or more: 10% off each week.',
    amountKind: 'percentage',
    amountValue: 1_000,
    eligibilityRules: { programIds: [campProgram], minLines: 2 },
    stackingRule: 'stackable',
    stackingPriority: 100,
    rounding: 'half_up',
    allocationMethod: 'proportional',
    effectiveFrom: calendar.iso(-1, '00:00'),
    status: 'active',
    policyReferences: [],
  });
  await discount({
    name: 'Early bird',
    description: 'Register for the spring league early.',
    amountKind: 'percentage',
    amountValue: 1_000,
    eligibilityRules: { offeringIds: [league.id], registrationBefore: calendar.iso(14, '23:59') },
    stackingRule: 'stackable',
    stackingPriority: 100,
    rounding: 'half_up',
    allocationMethod: 'proportional',
    effectiveFrom: calendar.iso(-1, '00:00'),
    status: 'active',
    policyReferences: [],
  });
  await discount({
    code: PROMO_CODE,
    name: 'Friends of the park',
    description: 'A sample promo code for the spring league.',
    amountKind: 'fixed',
    amountValue: 1_200,
    currency: 'USD',
    eligibilityRules: { offeringIds: [league.id] },
    stackingRule: 'stackable',
    stackingPriority: 200,
    rounding: 'half_up',
    allocationMethod: 'proportional',
    effectiveFrom: calendar.iso(-1, '00:00'),
    status: 'active',
    policyReferences: [],
  });

  // Other families take places: camp week 1 has 3 left, week 3 is full, Goalkeeper Basics is full.
  const family = (key: string): DemoFamily => {
    const found = families.find((f) => f.key === key);
    if (!found) throw new Error(`no demo family ${key}`);
    return found;
  };
  const paid: CheckoutPayment = {
    method: 'provider',
    paymentMethodToken: FakePaymentTokens.succeed,
  };
  const [week1, , week3] = campWeeks as [Offering, Offering, Offering, Offering];
  for (const [key, offering] of [
    ['alder', week1],
    ['dune', week3],
    ['fern', week3],
    ['alder', goalkeeper],
  ] as const) {
    const f = family(key);
    const child = f.children[0];
    if (!child) continue;
    await register(ctx, f.adult.principal, f.adult.personId, child.personId, offering.id, paid);
  }
  await settle(ctx);

  // Maya waits for Goalkeeper Basics, then a place opens and is offered to her (2e).
  const parent = await requirePrincipal(ctx, 'dev-parent');
  await offerWaitlistPlace(ctx, manager, parent, devChildPersonId, goalkeeper, calendar);
}

/** A basket, a hold, a quote and a card checkout by the parent; skipped when already placed. */
async function register(
  ctx: DemoContext,
  parent: Principal,
  parentPersonId: string,
  participantPersonId: string,
  offeringId: string,
  payment: CheckoutPayment,
): Promise<void> {
  const enrollments = service(ctx, EnrollmentsService);
  const listed = await enrollments.list(parent, { participantPersonId, offeringId, limit: 5 });
  if (listed.items.length > 0) return;
  const baskets = service(ctx, BasketsService);
  let basket = await baskets.create(
    parent,
    {
      ownerPersonId: parentPersonId,
      fulfillmentMode: 'all_or_nothing',
      acceptPartialFulfillment: false,
      policyReferences: [],
    },
    null,
  );
  basket = await baskets.addLine(
    parent,
    basket.id,
    { participantPersonId, offeringId, intent: 'youth', quantity: 1, policyReferences: [] },
    null,
  );
  basket = await baskets.hold(
    parent,
    basket.id,
    { expectedRevision: basket.revision, policyReferences: [] },
    null,
  );
  const quote = await service(ctx, QuotesService).create(
    parent,
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
    parent,
    { quoteId: quote.id, payment, authorizeFutureInstallments: false, policyReferences: [] },
    null,
  );
}

/**
 * Maya joins the waitlist of the full offering; a second place is then made (the coach takes one
 * more keeper) and offered to her. The offer's deadline is the API's (DEC-006 waitlist policy).
 */
async function offerWaitlistPlace(
  ctx: DemoContext,
  manager: Principal,
  parent: Principal,
  childPersonId: string,
  offering: Offering,
  calendar: DemoCalendar,
): Promise<void> {
  const waitlist = service(ctx, WaitlistService);
  const offerings = service(ctx, OfferingsService);
  let entry = (await waitlist.list(manager, { offeringId: offering.id })).find(
    (e) => e.participantPersonId === childPersonId,
  );
  if (!entry) {
    entry = await waitlist.join(
      parent,
      {
        offeringId: offering.id,
        participantPersonId: childPersonId,
        intent: 'youth',
        preferences: {},
        policyReferences: [],
      },
      null,
    );
  }
  if (entry.status !== 'waiting') return;
  const current = await offerings.get(manager, offering.id);
  const revision = current.staff?.revision;
  if (revision === undefined) throw new Error('the manager reads no staff details of the offering');
  if (current.capacity.every((c) => c.limit < 2)) {
    await offerings.update(
      manager,
      offering.id,
      {
        capacityUnits: [{ unit: 'seats', limit: 2 }],
        expectedRevision: revision,
        reason: 'A second coach can take one more keeper.',
        policyReferences: [],
      },
      null,
    );
    await settle(ctx);
  }
  const after = await waitlist.get(manager, entry.id);
  if (after.status !== 'waiting') return;
  await waitlist.offerNext(
    manager,
    entry.id,
    {
      expectedRevision: after.revision,
      reason: `A place opened on ${calendar.today}.`,
      policyReferences: [],
    },
    null,
  );
  await settle(ctx);
}
