import type { Offering, PriceRule, Principal } from '@sportspark/contracts';
import {
  EntitlementDefinitionsService,
  OfferingExtrasService,
  OfferingsService,
  PoliciesService,
  PriceRulesService,
  ProgramsService,
  SessionsService,
  WaiversService,
} from '../../modules/catalog';
import { EventSeriesService, EventsService } from '../../modules/scheduling';
import {
  calendarOf,
  service,
  soon,
  waitUntil,
  type DemoCalendar,
  type DemoContext,
} from './context';
import type { DemoStaff } from './people';
import type { DemoSpaces } from './spaces';

/**
 * Policies, programs and offerings (SPK-CAT-001 to 004), with what the amendments add: a class
 * priced per session (SPK-PAY-013), a class with a member price and the membership that grants it
 * (SPK-PAY-015), a camp sold by tier with add-ons and a uniform (SPK-PAY-014, SPK-REG-012) and a
 * liability waiver required on the offerings (SPK-REG-011). Sessions are put on the calendar the
 * way a scheduler does it: an event series on a space, then one session per event.
 *
 * Prices, sizes, capacities and wording are sample values, never policy defaults.
 */
export const WAIVER_KEY = 'demo-liability-waiver';
export const RENTAL_TERMS_KEY = 'demo-field-rental-terms';

export interface DemoSession {
  id: string;
  /** Days from today (facility-local). */
  dayOffset: number;
  start: string;
  end: string;
  eventId: string;
}

export interface DemoOffering {
  id: string;
  name: string;
  sessions: DemoSession[];
  rule: PriceRule | null;
}

export interface DemoCatalog {
  waiverVersionId: string;
  membershipDefinitionId: string;
  termClass: DemoOffering;
  perSessionClass: DemoOffering;
  memberClass: DemoOffering;
  smallClass: DemoOffering;
  approvalClass: DemoOffering;
  camp: DemoOffering & {
    addons: { lunch: string; earlyDropOff: string; teamPhoto: string };
    uniformId: string;
  };
  membership: DemoOffering;
  rental: DemoOffering;
  draftOffering: DemoOffering;
}

interface Policies {
  eligibility: string;
  approvalEligibility: string;
  cancellation: string;
  waiver: string;
}

async function ensurePolicy(
  ctx: DemoContext,
  manager: Principal,
  input: {
    kind: 'eligibility' | 'cancellation' | 'waiver' | 'booking_terms';
    key: string;
    title: string;
    content: Record<string, unknown>;
  },
  effectiveFrom: string,
): Promise<string> {
  const policies = service(ctx, PoliciesService);
  const listed = await policies.list(manager, { kind: input.kind, key: input.key, limit: 50 });
  const approved = listed.items.find((v) => v.approvalStatus === 'approved');
  if (approved) return approved.id;
  const draft =
    listed.items.find((v) => v.approvalStatus === 'draft') ??
    (await policies.createPolicyVersion(
      manager,
      { ...input, effectiveFrom, policyReferences: [] },
      null,
    ));
  await policies.approve(manager, draft.id, { policyReferences: [] }, null);
  return draft.id;
}

async function seedPolicies(
  ctx: DemoContext,
  manager: Principal,
  calendar: DemoCalendar,
): Promise<Policies> {
  const since = calendar.iso(-60, '00:00');
  return {
    eligibility: await ensurePolicy(
      ctx,
      manager,
      {
        kind: 'eligibility',
        key: 'demo-open-eligibility',
        title: 'Open to the age band of the program',
        content: { text: 'Anyone in the age band of the program may register.' },
      },
      since,
    ),
    approvalEligibility: await ensurePolicy(
      ctx,
      manager,
      {
        kind: 'eligibility',
        key: 'demo-coach-approval',
        title: 'By coach approval',
        content: {
          text: 'A coach reviews each application before a place is offered.',
          requiresApproval: true,
        },
      },
      since,
    ),
    cancellation: await ensurePolicy(
      ctx,
      manager,
      {
        kind: 'cancellation',
        key: 'demo-cancellation',
        title: 'Sample cancellation terms',
        content: {
          text: 'Sample terms: half of the price is refunded when a place is canceled.',
          refundBasisPoints: 5_000,
        },
      },
      since,
    ),
    waiver: await ensurePolicy(
      ctx,
      manager,
      {
        kind: 'waiver',
        key: WAIVER_KEY,
        title: 'Liability waiver (sample wording)',
        content: {
          text: 'Sample wording for the demo. I understand that sport carries a risk of injury and I accept that risk for myself or for the child I am responsible for.',
          renewal: { reacceptOnNewVersion: false, renewEveryMonths: 12 },
          enforcement: 'warn',
          overrideRoles: ['general_manager'],
        },
      },
      since,
    ),
  };
}

interface OfferingSpec {
  name: string;
  description: string;
  kind: Offering['kind'];
  locationLabel: string;
  resourceIds?: string[];
  startsOn: string;
  endsOn: string;
  seats: number;
  capacityUnit?: 'seats' | 'rental_resources';
  entitlementDefinitionId: string;
  bookingTermsKey?: string;
  eligibilityPolicyVersionId?: string;
  publish: boolean;
}

export async function seedCatalog(
  ctx: DemoContext,
  staff: DemoStaff,
  spaces: DemoSpaces,
): Promise<DemoCatalog> {
  const manager = staff.manager.principal;
  const calendar = calendarOf(ctx);
  const policies = await seedPolicies(ctx, manager, calendar);
  const programs = service(ctx, ProgramsService);
  const offerings = service(ctx, OfferingsService);
  const definitions = service(ctx, EntitlementDefinitionsService);
  const sessions = service(ctx, SessionsService);
  const priceRules = service(ctx, PriceRulesService);
  const extras = service(ctx, OfferingExtrasService);
  const waivers = service(ctx, WaiversService);
  const series = service(ctx, EventSeriesService);
  const events = service(ctx, EventsService);

  const knownPrograms = (await programs.list(manager, { limit: 200 })).items;
  const ensureProgram = async (
    name: string,
    ageBand: { minAgeYears?: number; maxAgeYears?: number },
    description: string,
  ): Promise<string> =>
    knownPrograms.find((p) => p.name === name)?.id ??
    (
      await programs.create(
        manager,
        {
          name,
          description,
          activityType: 'soccer',
          format: '5v5',
          ageBand,
          status: 'active',
          policyReferences: [],
        },
        null,
      )
    ).id;

  const knownDefinitions = await definitions.list(manager, {});
  const ensureDefinition = async (
    name: string,
    kind: 'seat' | 'membership_benefit' | 'rental_resource',
    scope: Record<string, unknown>,
    equivalenceScope: 'offering' | 'none',
  ): Promise<string> =>
    knownDefinitions.find((d) => d.name === name)?.id ??
    (
      await definitions.create(
        manager,
        { name, kind, scope, equivalenceScope, equivalenceRule: {}, policyReferences: [] },
        null,
      )
    ).id;

  const seat = await ensureDefinition(
    'A place in a class or camp',
    'seat',
    { sessionsIncluded: 'all' },
    'offering',
  );
  const membershipDefinitionId = await ensureDefinition(
    'Park membership benefit',
    'membership_benefit',
    {
      attendance: { mode: 'none' },
      term: { kind: 'offering_dates' },
      renewal: { noticeLeadDays: 14 },
    },
    'none',
  );
  const rentalDefinition = await ensureDefinition(
    'Field 1 rental',
    'rental_resource',
    {
      resources: {
        resourceIds: [spaces.field1, spaces.field1North, spaces.field1South],
        count: 1,
      },
      staffing: [],
    },
    'none',
  );
  await ensurePolicy(
    ctx,
    manager,
    {
      kind: 'booking_terms',
      key: RENTAL_TERMS_KEY,
      title: 'Field rental terms (sample)',
      content: {
        confirmationMode: 'instant',
        installmentPolicyKey: null,
        accessConditions: 'Check in at the front desk before going to the field.',
        hostResponsibilities: 'The renter is responsible for everyone on the roster.',
      },
    },
    calendar.iso(-60, '00:00'),
  );

  const youth = await ensureProgram(
    'Youth soccer school',
    { minAgeYears: 5, maxAgeYears: 12 },
    'Weekly classes for children, by age and level.',
  );
  const camps = await ensureProgram(
    'School holiday camps',
    { minAgeYears: 5, maxAgeYears: 12 },
    'Full days of play during school holidays.',
  );
  const community = await ensureProgram(
    'Memberships and rentals',
    {},
    'Park membership and field rental for groups.',
  );

  const offeringsOf = new Map<string, Offering[]>();
  const ensureOffering = async (
    programId: string,
    spec: OfferingSpec,
  ): Promise<{ offering: Offering; created: boolean }> => {
    let listed = offeringsOf.get(programId);
    if (!listed) {
      listed = (await offerings.listForProgram(manager, programId, { limit: 200 })).items;
      offeringsOf.set(programId, listed);
    }
    const known = listed.find((o) => o.name === spec.name);
    if (known) return { offering: known, created: false };
    const created = await offerings.create(
      manager,
      {
        programId,
        name: spec.name,
        description: spec.description,
        kind: spec.kind,
        facilityId: ctx.facilityId,
        activityType: 'soccer',
        format: '5v5',
        location: { label: spec.locationLabel, resourceIds: spec.resourceIds },
        startsOn: spec.startsOn,
        endsOn: spec.endsOn,
        registrationOpensAt: calendar.iso(-30, '09:00'),
        registrationClosesAt: calendar.iso(45, '21:00'),
        eligibilityPolicyVersionId: spec.eligibilityPolicyVersionId ?? policies.eligibility,
        entitlementDefinitionId: spec.entitlementDefinitionId,
        capacityUnits: [{ unit: spec.capacityUnit ?? 'seats', limit: spec.seats }],
        requiredFormPolicyVersionIds: [],
        cancellationPolicyVersionId: policies.cancellation,
        responsibleManagerPersonId: staff.manager.personId,
        bookingTermsKey: spec.bookingTermsKey,
        policyReferences: [],
      },
      null,
    );
    return { offering: created, created: true };
  };

  /** Puts a class on the calendar: a series of events on a space, then a session per event. */
  const scheduleSessions = async (
    offering: Offering,
    plan: {
      title: string;
      frequency: 'weekly' | 'daily';
      firstDay: number;
      count: number;
      time: string;
      minutes: number;
      resourceId: string;
      coachPersonId?: string;
    },
  ): Promise<void> => {
    const created = await series.createSeries(manager, {
      facilityId: ctx.facilityId,
      kind: 'session',
      title: plan.title,
      sport: 'soccer',
      recurrence: {
        frequency: plan.frequency,
        interval: 1,
        startDate: calendar.day(plan.firstDay),
        count: plan.count,
      },
      localStartTime: plan.time,
      durationMinutes: plan.minutes,
      resourceIds: [plan.resourceId],
      commitments: plan.coachPersonId
        ? [{ partyType: 'person', partyId: plan.coachPersonId, role: 'coach' }]
        : [],
      sourceType: 'offering',
      sourceId: offering.id,
      policyReferences: [],
    });
    const occurrences = [];
    for (const eventId of created.eventIds)
      occurrences.push(await events.getEvent(manager, eventId));
    occurrences.sort((a, b) => a.scheduledStart.localeCompare(b.scheduledStart));
    for (const event of occurrences) {
      await sessions.create(
        manager,
        offering.id,
        {
          scheduledStart: event.scheduledStart,
          scheduledEnd: event.scheduledEnd,
          schedulingEventId: event.id,
          policyReferences: [],
        },
        null,
      );
    }
  };

  const describe = async (offering: Offering): Promise<DemoOffering> => {
    const listed = await sessions.list(manager, offering.id);
    const rules = await priceRules.list(manager, offering.id);
    const dayMs = 86_400_000;
    const midnight = calendar.at(0, '00:00').getTime();
    return {
      id: offering.id,
      name: offering.name,
      rule: rules[rules.length - 1] ?? null,
      sessions: listed
        .filter((s) => s.status !== 'canceled')
        .map((s) => ({
          id: s.id,
          // Rounded so a daylight-saving change between today and the session does not shift it.
          dayOffset: Math.round((new Date(s.scheduledStart).getTime() - midnight) / dayMs - 0.25),
          start: s.scheduledStart,
          end: s.scheduledEnd,
          eventId: s.schedulingEventId as string,
        }))
        .sort((a, b) => a.start.localeCompare(b.start)),
    };
  };

  // Declared before `publish`, which waits for the price it was given to be in effect: an
  // offering is published with the price families will be quoted (SPK-CAT-004, SPK-PAY-002).
  let latestPrice = ctx.clock.now().toISOString();
  const priceFrom = async (): Promise<string> => {
    latestPrice = await soon(ctx);
    return latestPrice;
  };
  const publish = async (offering: Offering): Promise<void> => {
    await waitUntil(ctx, latestPrice);
    await waivers.setOfferingRequiredWaivers(
      manager,
      offering.id,
      { policyKeys: [WAIVER_KEY], policyReferences: [] },
      null,
    );
    await offerings.publish(manager, offering.id, { policyReferences: [] }, null);
    await offerings.openRegistration(manager, offering.id, { policyReferences: [] }, null);
  };

  // 1. A weekly class with a term price, on today's weekday: a session today.
  const term = await ensureOffering(youth, {
    name: 'Mini kickers (ages 5 to 8)',
    description: 'First touches, small games and a lot of running. One hour a week.',
    kind: 'term',
    locationLabel: 'Field 1, north half',
    resourceIds: [spaces.field1North],
    startsOn: calendar.day(-21),
    endsOn: calendar.day(28),
    seats: 12,
    entitlementDefinitionId: seat,
    publish: true,
  });
  if (term.created) {
    await scheduleSessions(term.offering, {
      title: 'Mini kickers',
      frequency: 'weekly',
      firstDay: -21,
      count: 8,
      time: '16:00',
      minutes: 60,
      resourceId: spaces.field1North,
      coachPersonId: staff.coach.personId,
    });
    await priceRules.create(
      manager,
      term.offering.id,
      {
        effectiveFrom: await priceFrom(),
        basePriceMinor: 18_000,
        currency: 'USD',
        chargeLines: [],
        pricingBasis: 'term',
        tiers: [],
        policyReferences: [],
      },
      null,
    );
    await publish(term.offering);
  }

  // 2. A class priced per session, three sessions into its term (SPK-PAY-013).
  const perSession = await ensureOffering(youth, {
    name: 'Skills academy (ages 8 to 12)',
    description: 'Ball mastery and one-on-one play. Join any week and pay for the classes left.',
    kind: 'term',
    locationLabel: 'Field 1, south half',
    resourceIds: [spaces.field1South],
    startsOn: calendar.day(-20),
    endsOn: calendar.day(29),
    seats: 10,
    entitlementDefinitionId: seat,
    publish: true,
  });
  if (perSession.created) {
    await scheduleSessions(perSession.offering, {
      title: 'Skills academy',
      frequency: 'weekly',
      firstDay: -20,
      count: 8,
      time: '17:00',
      minutes: 60,
      resourceId: spaces.field1South,
      coachPersonId: staff.secondCoach.personId,
    });
    await priceRules.create(
      manager,
      perSession.offering.id,
      {
        effectiveFrom: await priceFrom(),
        basePriceMinor: 2_400,
        currency: 'USD',
        chargeLines: [],
        pricingBasis: 'per_session',
        tiers: [],
        policyReferences: [],
      },
      null,
    );
    await publish(perSession.offering);
  }

  // 3. The membership, then a class with a member price that the membership grants (SPK-PAY-015).
  const membership = await ensureOffering(community, {
    name: 'Park membership (season)',
    description: 'Members pay the member price on classes that have one.',
    kind: 'membership',
    locationLabel: 'Front desk',
    startsOn: calendar.day(-30),
    endsOn: calendar.day(150),
    seats: 500,
    entitlementDefinitionId: membershipDefinitionId,
    publish: true,
  });
  if (membership.created) {
    await priceRules.create(
      manager,
      membership.offering.id,
      {
        effectiveFrom: await priceFrom(),
        basePriceMinor: 4_900,
        currency: 'USD',
        chargeLines: [],
        pricingBasis: 'term',
        tiers: [],
        policyReferences: [],
      },
      null,
    );
    await waitUntil(ctx, latestPrice);
    await offerings.publish(manager, membership.offering.id, { policyReferences: [] }, null);
    await offerings.openRegistration(
      manager,
      membership.offering.id,
      { policyReferences: [] },
      null,
    );
  }
  const member = await ensureOffering(youth, {
    name: 'Futsal club (ages 7 to 12)',
    description: 'Fast five-a-side on the court. Members of the park pay less.',
    kind: 'term',
    locationLabel: 'Court',
    resourceIds: [spaces.court],
    startsOn: calendar.day(-5),
    endsOn: calendar.day(44),
    seats: 10,
    entitlementDefinitionId: seat,
    publish: true,
  });
  if (member.created) {
    await scheduleSessions(member.offering, {
      title: 'Futsal club',
      frequency: 'weekly',
      firstDay: -5,
      count: 8,
      time: '18:00',
      minutes: 60,
      resourceId: spaces.court,
      coachPersonId: staff.coach.personId,
    });
    await priceRules.create(
      manager,
      member.offering.id,
      {
        effectiveFrom: await priceFrom(),
        basePriceMinor: 16_000,
        currency: 'USD',
        chargeLines: [],
        pricingBasis: 'term',
        memberPriceMinor: 12_000,
        memberEntitlementDefinitionId: membershipDefinitionId,
        tiers: [],
        policyReferences: [],
      },
      null,
    );
    await publish(member.offering);
  }

  // 4. A small class that is full, so the waitlist has someone on it.
  const small = await ensureOffering(youth, {
    name: 'Goalkeeper clinic (ages 8 to 12)',
    description: 'Two keepers and a coach: handling, footwork and distribution.',
    kind: 'term',
    locationLabel: 'Field 2',
    resourceIds: [spaces.field2],
    startsOn: calendar.day(2),
    endsOn: calendar.day(51),
    seats: 2,
    entitlementDefinitionId: seat,
    publish: true,
  });
  if (small.created) {
    await scheduleSessions(small.offering, {
      title: 'Goalkeeper clinic',
      frequency: 'weekly',
      firstDay: 2,
      count: 8,
      time: '15:00',
      minutes: 45,
      resourceId: spaces.field2,
      coachPersonId: staff.secondCoach.personId,
    });
    await priceRules.create(
      manager,
      small.offering.id,
      {
        effectiveFrom: await priceFrom(),
        basePriceMinor: 22_000,
        currency: 'USD',
        chargeLines: [],
        pricingBasis: 'term',
        tiers: [],
        policyReferences: [],
      },
      null,
    );
    await publish(small.offering);
  }

  // 4b. A squad that takes players only after a coach has approved the application.
  const approval = await ensureOffering(youth, {
    name: 'Advanced squad (by coach approval)',
    description: 'For players moving up from the skills academy. A coach reviews each application.',
    kind: 'term',
    locationLabel: 'Field 2',
    resourceIds: [spaces.field2],
    startsOn: calendar.day(4),
    endsOn: calendar.day(39),
    seats: 14,
    entitlementDefinitionId: seat,
    eligibilityPolicyVersionId: policies.approvalEligibility,
    publish: true,
  });
  if (approval.created) {
    await scheduleSessions(approval.offering, {
      title: 'Advanced squad',
      frequency: 'weekly',
      firstDay: 4,
      count: 6,
      time: '16:30',
      minutes: 75,
      resourceId: spaces.field2,
    });
    await priceRules.create(
      manager,
      approval.offering.id,
      {
        effectiveFrom: await priceFrom(),
        basePriceMinor: 24_000,
        currency: 'USD',
        chargeLines: [],
        pricingBasis: 'term',
        tiers: [],
        policyReferences: [],
      },
      null,
    );
    await publish(approval.offering);
  }

  // 5. The holiday camp: Monday to Friday of next week, sold by tier, with add-ons and a jersey.
  const campStart = calendar.weekStart + 7;
  const camp = await ensureOffering(camps, {
    name: 'Holiday camp week',
    description:
      'Five days of games, skills and a small tournament on Friday. Come all week or day by day.',
    kind: 'camp',
    locationLabel: 'Field 3',
    resourceIds: [spaces.field3],
    startsOn: calendar.day(campStart),
    endsOn: calendar.day(campStart + 4),
    seats: 24,
    entitlementDefinitionId: seat,
    publish: true,
  });
  if (camp.created) {
    await scheduleSessions(camp.offering, {
      title: 'Holiday camp',
      frequency: 'daily',
      firstDay: campStart,
      count: 5,
      time: '13:00',
      minutes: 240,
      resourceId: spaces.field3,
    });
    await priceRules.create(
      manager,
      camp.offering.id,
      {
        effectiveFrom: await priceFrom(),
        basePriceMinor: 32_000,
        currency: 'USD',
        chargeLines: [],
        pricingBasis: 'term',
        tiers: [
          { code: 'full_week', name: 'Full week', attendance: 'all_sessions', priceMinor: 32_000 },
          {
            code: 'single_day',
            name: 'Single day',
            attendance: 'chosen_sessions',
            minSessions: 1,
            maxSessions: 1,
            priceMinor: 7_500,
          },
        ],
        policyReferences: [],
      },
      null,
    );
    const addon = (body: {
      code: string;
      name: string;
      description: string;
      priceMinor: number;
      selection: 'per_registration' | 'per_session';
      capacity?: number;
    }) =>
      extras.createAddon(
        manager,
        camp.offering.id,
        { ...body, currency: 'USD', chargeLines: [], policyReferences: [] },
        null,
      );
    await addon({
      code: 'lunch',
      name: 'Lunch',
      description: 'A packed lunch on the days chosen.',
      priceMinor: 900,
      selection: 'per_session',
    });
    await addon({
      code: 'early_drop_off',
      name: 'Early drop-off',
      description: 'Supervised from an hour before camp starts.',
      priceMinor: 1_200,
      selection: 'per_session',
    });
    await addon({
      code: 'friday_trophy_photo',
      name: 'Friday team photo',
      description: 'A printed team photo from the Friday tournament. Six left.',
      priceMinor: 1_500,
      selection: 'per_registration',
      capacity: 6,
    });
    await extras.createUniform(
      manager,
      camp.offering.id,
      {
        itemKey: 'camp-jersey',
        name: 'Camp jersey',
        sizes: ['Youth S', 'Youth M', 'Youth L'],
        requirement: 'optional',
        priceMinor: 2_200,
        currency: 'USD',
        chargeLines: [],
        returningHolderFree: false,
        policyReferences: [],
      },
      null,
    );
    await publish(camp.offering);
  }

  // 6. Field rental (SPK-COND-003): the renter books Field 1 whole or by half.
  const rental = await ensureOffering(community, {
    name: 'Field 1 rental',
    description: 'Rent Field 1 whole, or one half, by the hour.',
    kind: 'rental',
    locationLabel: 'Field 1',
    resourceIds: [spaces.field1],
    startsOn: calendar.day(-30),
    endsOn: calendar.day(150),
    seats: 1,
    capacityUnit: 'rental_resources',
    entitlementDefinitionId: rentalDefinition,
    bookingTermsKey: RENTAL_TERMS_KEY,
    publish: true,
  });
  if (rental.created) {
    await priceRules.create(
      manager,
      rental.offering.id,
      {
        effectiveFrom: await priceFrom(),
        basePriceMinor: 12_000,
        currency: 'USD',
        chargeLines: [],
        pricingBasis: 'term',
        tiers: [],
        policyReferences: [],
      },
      null,
    );
    await publish(rental.offering);
  }

  // 7. A class still being set up, so Programs shows a draft beside the published ones.
  const draft = await ensureOffering(youth, {
    name: 'Spring term: mini kickers (draft)',
    description: 'Next term, not yet published.',
    kind: 'term',
    locationLabel: 'Field 1, north half',
    startsOn: calendar.day(70),
    endsOn: calendar.day(126),
    seats: 12,
    entitlementDefinitionId: seat,
    publish: false,
  });

  // Every price is in effect before the first family registers.
  await waitUntil(ctx, latestPrice);
  const campOffering = await describe(camp.offering);
  const addons = await extras.listAddons(manager, camp.offering.id);
  const uniforms = await extras.listUniforms(manager, camp.offering.id);
  const addonId = (code: string): string => {
    const found = addons.find((a) => a.code === code);
    if (!found) throw new Error(`the camp add-on ${code} is missing`);
    return found.id;
  };
  const uniform = uniforms.find((u) => u.itemKey === 'camp-jersey');
  if (!uniform) throw new Error('the camp jersey is missing');
  return {
    waiverVersionId: policies.waiver,
    membershipDefinitionId,
    termClass: await describe(term.offering),
    perSessionClass: await describe(perSession.offering),
    memberClass: await describe(member.offering),
    smallClass: await describe(small.offering),
    approvalClass: await describe(approval.offering),
    camp: {
      ...campOffering,
      addons: {
        lunch: addonId('lunch'),
        earlyDropOff: addonId('early_drop_off'),
        teamPhoto: addonId('friday_trophy_photo'),
      },
      uniformId: uniform.id,
    },
    membership: await describe(membership.offering),
    rental: await describe(rental.offering),
    draftOffering: await describe(draft.offering),
  };
}
