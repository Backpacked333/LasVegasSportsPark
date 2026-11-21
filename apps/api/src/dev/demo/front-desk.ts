import type { CheckoutPayment, Offering, Principal } from '@sportspark/contracts';
import { UnitOfWork } from '../../kernel/database/unit-of-work';
import {
  EntitlementDefinitionsService,
  OfferingsService,
  PoliciesService,
  PriceRulesService,
  ProgramsService,
  SessionsService,
} from '../../modules/catalog';
import { BasketsService, EnrollmentsService } from '../../modules/enrollment';
import {
  CheckoutService,
  CreditsService,
  FakePaymentTokens,
  MoneyReadsService,
  ObligationsService,
  QuotesService,
} from '../../modules/finance';
import {
  AccountsService,
  ALL_PERMISSIONS,
  AuthorityReadsService,
  CareNotesService,
  HouseholdsService,
  PeopleService,
  RelationshipsService,
} from '../../modules/identity';
import { EventSeriesService, EventsService } from '../../modules/scheduling';
import { CasesService } from '../../modules/support';
import {
  calendarOf,
  optional,
  principalOf,
  requirePrincipal,
  service,
  settle,
  soon,
  waitUntil,
  type DemoCalendar,
  type DemoContext,
} from './context';
import type { DemoStaff } from './people';
import type { DemoSpaces } from './spaces';

/**
 * The front desk's family (staff S 2a, S 3c, S 3d, S 4a, S 4b, S 4c): the Ortiz household, a
 * parent and two children, built through the modules' own services like every demo stage.
 *
 * - Maya (8) and Leo (5) each have a session at the facility within the next hour or so of the
 *   seed's clock. Leo's class requires a signed form ("Liability waiver", a `form` policy of that
 *   offering only) that Dana has not signed: a required form blocks at check-in, so the desk shows
 *   him "not cleared" with "Dana signs on this tablet". A form is required by its offering, so no
 *   other family's records change (a new waiver family would be listed on every person).
 * - Maya has an allergy care note (shown on her card, audited).
 * - Two league instalment fees are owed by Dana, and Dana holds a family credit.
 * - Maya's place in a later camp week was paid by card, and Dana asked in the app to cancel that
 *   week: a support request the desk approves as a refund (S 4b).
 *
 * Names, phone numbers (555-01xx) and wording are invented; amounts are sample values.
 */
export const DESK_FORM_KEY = 'demo-desk-liability-form';

const WAIVER_TEXT = [
  '1. Assumption of risk. I understand that participation in soccer, futsal and related activities at Sportspark involves inherent risks, including but not limited to collisions, falls, and contact with equipment.',
  '2. Medical treatment. In the event of injury, I authorize Sportspark staff to administer first aid and to contact emergency medical services on behalf of the participant.',
  '3. Photo and media. Photos taken at public events may be used in Sportspark materials unless I ask the front desk not to.',
].join('\n\n');

export interface DemoFrontDesk {
  householdId: string | null;
  parentPersonId: string | null;
}

/** "HH:MM" of an instant at the facility. */
function localTime(timezone: string, at: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(at);
}

/** The next quarter hour at least `leadMinutes` from now, as local "HH:MM" today (null after 22:00). */
function soonSlot(ctx: DemoContext, leadMinutes: number): string | null {
  const at = new Date(ctx.clock.now().getTime() + leadMinutes * 60_000);
  const quarter = 15 * 60_000;
  const rounded = new Date(Math.ceil(at.getTime() / quarter) * quarter);
  const time = localTime(ctx.timezone, rounded);
  const [hour] = time.split(':').map(Number) as [number];
  // A session has to start and end on today's facility-local date.
  if (hour >= 22 || time < localTime(ctx.timezone, ctx.clock.now())) return null;
  return time;
}

export async function seedFrontDesk(
  ctx: DemoContext,
  staff: DemoStaff,
  spaces: DemoSpaces,
): Promise<DemoFrontDesk> {
  const calendar = calendarOf(ctx);
  const manager = staff.manager.principal;

  const family = await optional(ctx, 'the Ortiz household at the front desk', () =>
    ensureFamily(ctx, calendar),
  );
  if (!family) return { householdId: null, parentPersonId: null };
  const { dana, maya, leo, householdId } = family;

  // Written when the family is first created: reading care notes is itself audited (§4.14), so a
  // second run must not read them to find out.
  if (family.created) {
    await optional(ctx, "Maya's allergy care note", () =>
      service(ctx, CareNotesService).record(
        manager,
        maya,
        {
          kind: 'allergy',
          body: 'Peanuts. Carries an adrenaline pen in her bag; call the parent at once.',
          policyReferences: [],
        },
        null,
      ),
    );
  }

  const offerings = await optional(ctx, "the desk family's sessions today", () =>
    ensureOfferings(ctx, staff, spaces, calendar),
  );
  if (offerings) {
    const paid: CheckoutPayment = {
      method: 'provider',
      paymentMethodToken: FakePaymentTokens.succeed,
    };
    for (const [personId, offering] of [
      [maya, offerings.training],
      [leo, offerings.skills],
      [maya, offerings.campWeek],
    ] as const) {
      if (!offering) continue;
      await optional(ctx, `a place in ${offering.name}`, () =>
        register(ctx, dana.principal, dana.personId, personId, offering.id, paid),
      );
    }
    await settle(ctx);
    // The class asks for the form from this season on, after the places were taken (a form is
    // required before a place is held): Dana has not signed it for Leo yet, so the desk holds him.
    const skills = offerings.skills;
    if (skills) {
      await optional(ctx, 'the form Junior Skills requires', async () => {
        const catalog = service(ctx, OfferingsService);
        const current = await catalog.get(manager, skills.id);
        const staffView = current.staff;
        if (!staffView) throw new Error('the manager reads no staff details of Junior Skills');
        if (current.requiredFormPolicyVersionIds.includes(offerings.formVersionId)) return;
        await catalog.update(
          manager,
          skills.id,
          {
            requiredFormPolicyVersionIds: [offerings.formVersionId],
            expectedRevision: staffView.revision,
            policyReferences: [],
          },
          null,
        );
      });
    }
    if (offerings.campWeek) {
      const campWeek = offerings.campWeek;
      await optional(ctx, "Dana's request to cancel a camp week", () =>
        refundRequest(ctx, manager, dana.principal, maya, campWeek.id),
      );
    }
  }

  await optional(ctx, "the Ortiz family's fees and credit", async () => {
    const obligations = service(ctx, ObligationsService);
    const owed = await obligations.list(manager, { debtorPersonId: dana.personId, limit: 50 });
    for (const [description, dueDay, amount] of [
      ['Spring Rec League · instalment 2 of 3 · Maya', 6, 4_000],
      ['Spring Rec League · instalment 3 of 3 · Maya', 37, 4_000],
    ] as const) {
      if (owed.items.some((o) => o.description === description)) continue;
      await obligations.create(
        manager,
        {
          debtor: { kind: 'person', personId: dana.personId },
          mode: 'individual',
          amountMinor: amount,
          currency: 'USD',
          dueAt: calendar.iso(dueDay, '18:00'),
          description,
          source: { kind: 'manual' },
          policyReferences: [],
        },
        null,
      );
    }
    const credits = service(ctx, CreditsService);
    const held = await credits.list(manager, { ownerPersonId: dana.personId, limit: 10 });
    if (held.items.length === 0) {
      await credits.issue(
        manager,
        {
          ownerPersonId: dana.personId,
          amountMinor: 2_500,
          currency: 'USD',
          permittedUses: ['obligation', 'registration'],
          sourceKind: 'goodwill',
          reason: 'Make-up class, Oct',
          policyReferences: [],
        },
        null,
      );
    }
  });
  await settle(ctx);
  return { householdId, parentPersonId: dana.personId };
}

async function ensureFamily(ctx: DemoContext, calendar: DemoCalendar) {
  const subject = 'demo-family-ortiz';
  const people = service(ctx, PeopleService);
  let principal = await principalOf(ctx, subject);
  const created = !principal?.personId;
  if (!principal?.personId) {
    const person = await people.createPerson(
      ctx.system,
      {
        kind: 'adult',
        givenName: 'Dana',
        familyName: 'Ortiz',
        dateOfBirth: `${Number(calendar.today.slice(0, 4)) - 36}-04-11`,
        contactPoints: [
          { kind: 'email', value: `${subject}@example.test`, isPrimary: true, verified: true },
          { kind: 'phone', value: '+17025550148', isPrimary: true, verified: true },
        ],
      },
      null,
    );
    await service(ctx, AccountsService).createAccount(
      ctx.system,
      { issuer: ctx.config.AUTH_ISSUER, subject, personId: person.id },
      null,
    );
    principal = await requirePrincipal(ctx, subject);
  }
  const dana = { personId: principal.personId as string, principal };
  const names = await people.personNames(
    ctx.system,
    (await service(ctx, AuthorityReadsService).personAuthority(ctx.system, dana.personId)).grants
      .filter((g) => g.actorPersonId === dana.personId)
      .map((g) => g.subjectPersonId),
  );
  const child = async (givenName: string, birth: string): Promise<string> => {
    const known = names.find((n) => n.givenName === givenName && n.familyName === 'Ortiz');
    if (known) return known.personId;
    const created = await people.createPerson(
      ctx.system,
      { kind: 'child', givenName, familyName: 'Ortiz', dateOfBirth: birth, contactPoints: [] },
      null,
    );
    await service(ctx, UnitOfWork).run(({ trx }) =>
      service(ctx, RelationshipsService).ensureAuthority(trx, ctx.system, ctx.organizationId, {
        actorPersonId: dana.personId,
        subjectPersonId: created.id,
        kind: 'guardian',
        permissions: ALL_PERMISSIONS,
        source: 'staff',
        correlationId: null,
      }),
    );
    return created.id;
  };
  const year = Number(calendar.today.slice(0, 4));
  const maya = await child('Maya', `${year - 9}-12-03`);
  const leo = await child('Leo', `${year - 6}-12-20`);
  const households = service(ctx, HouseholdsService);
  const mine = await service(ctx, AuthorityReadsService).myHouseholds(dana.principal);
  let householdId = mine[0]?.id ?? null;
  if (!householdId) {
    const household = await households.createHousehold(
      ctx.system,
      { name: 'Ortiz household' },
      null,
    );
    for (const personId of [dana.personId, maya, leo]) {
      await households.addMember(ctx.system, household.id, { personId }, null);
    }
    householdId = household.id;
  }
  return { dana, maya, leo, householdId, created };
}

interface DeskOfferings {
  /** The form Leo's class requires from this season on (approved; required after registration). */
  formVersionId: string;
  training: Offering | null;
  skills: Offering | null;
  campWeek: Offering | null;
}

async function ensureOfferings(
  ctx: DemoContext,
  staff: DemoStaff,
  spaces: DemoSpaces,
  calendar: DemoCalendar,
): Promise<DeskOfferings> {
  const manager = staff.manager.principal;
  const policies = service(ctx, PoliciesService);
  const programs = service(ctx, ProgramsService);
  const offerings = service(ctx, OfferingsService);
  const priceRules = service(ctx, PriceRulesService);
  const sessions = service(ctx, SessionsService);
  const series = service(ctx, EventSeriesService);
  const events = service(ctx, EventsService);

  // The form Leo's class requires (a required form blocks at check-in until it is signed).
  const forms = await policies.list(manager, { kind: 'form', key: DESK_FORM_KEY, limit: 10 });
  let formVersionId = forms.items.find((v) => v.approvalStatus === 'approved')?.id ?? null;
  if (!formVersionId) {
    const draft =
      forms.items.find((v) => v.approvalStatus === 'draft') ??
      (await policies.createPolicyVersion(
        manager,
        {
          kind: 'form',
          key: DESK_FORM_KEY,
          title: 'Liability waiver',
          content: { text: WAIVER_TEXT },
          effectiveFrom: calendar.iso(-60, '00:00'),
          policyReferences: [],
        },
        null,
      ));
    await policies.approve(manager, draft.id, { policyReferences: [] }, null);
    formVersionId = draft.id;
  }
  const policy = async (kind: 'eligibility' | 'cancellation', key: string): Promise<string> => {
    const found = await policies.list(manager, { kind, key, limit: 20 });
    const approved = found.items.find((v) => v.approvalStatus === 'approved');
    if (!approved) throw new Error(`no approved ${kind} policy ${key} in the demo catalog`);
    return approved.id;
  };
  // Open to the age band (no coach approval), and the demo's cancellation terms.
  const eligibility = await policy('eligibility', 'demo-open-eligibility');
  const cancellation = await policy('cancellation', 'demo-cancellation');
  const youth = (await programs.list(manager, { limit: 200 })).items.find(
    (p) => p.name === 'Youth soccer school',
  );
  if (!youth) throw new Error('the youth program of the demo catalog is missing');
  const known = (await offerings.listForProgram(manager, youth.id, { limit: 200 })).items;
  const seat = (await service(ctx, EntitlementDefinitionsService).list(manager, {})).find(
    (d) => d.name === 'A place in a class or camp',
  )?.id;
  if (!seat) throw new Error('the seat entitlement of the demo catalog is missing');

  const ensure = async (spec: {
    name: string;
    resourceId: string;
    label: string;
    time: string | null;
    startsOn: string;
    endsOn: string;
    priceMinor: number;
  }): Promise<Offering | null> => {
    const existing = known.find((o) => o.name === spec.name);
    if (existing) return existing;
    const created = await offerings.create(
      manager,
      {
        programId: youth.id,
        name: spec.name,
        description: 'Front desk demo: a session at the facility today.',
        kind: 'term',
        facilityId: ctx.facilityId,
        activityType: 'soccer',
        format: '5v5',
        location: { label: spec.label, resourceIds: [spec.resourceId] },
        startsOn: spec.startsOn,
        endsOn: spec.endsOn,
        registrationOpensAt: calendar.iso(-30, '09:00'),
        registrationClosesAt: calendar.iso(45, '21:00'),
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
    if (spec.time) {
      const made = await series.createSeries(manager, {
        facilityId: ctx.facilityId,
        kind: 'session',
        title: spec.name,
        sport: 'soccer',
        recurrence: { frequency: 'daily', interval: 1, startDate: spec.startsOn, count: 1 },
        localStartTime: spec.time,
        durationMinutes: 60,
        resourceIds: [spec.resourceId],
        commitments: [],
        sourceType: 'offering',
        sourceId: created.id,
        policyReferences: [],
      });
      for (const eventId of made.eventIds) {
        const event = await events.getEvent(manager, eventId);
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
    await offerings.publish(manager, created.id, { policyReferences: [] }, null);
    await offerings.openRegistration(manager, created.id, { policyReferences: [] }, null);
    return created;
  };

  const first = soonSlot(ctx, 15);
  const second = soonSlot(ctx, 75);
  if (!first || !second) {
    // Late in the facility day there is no "next hour" to show: the family is still seeded, with
    // its fees, credit and camp week, and the desk shows them without a session today.
    ctx.log("  the desk family's sessions today: too late in the facility day, skipped");
  }
  return {
    formVersionId,
    training:
      first !== null
        ? await ensure({
            name: 'Desert Foxes U9 training',
            resourceId: spaces.field2,
            label: 'Field 2',
            time: first,
            startsOn: calendar.today,
            endsOn: calendar.today,
            priceMinor: 12_000,
          })
        : null,
    skills:
      second !== null
        ? await ensure({
            name: 'Junior Skills',
            resourceId: spaces.court,
            label: 'Court 1',
            time: second,
            startsOn: calendar.today,
            endsOn: calendar.today,
            priceMinor: 9_600,
          })
        : null,
    campWeek: await ensure({
      name: 'Winter Break Camp · week 2',
      resourceId: spaces.field3,
      label: 'Field 3',
      time: null,
      startsOn: calendar.day(38),
      endsOn: calendar.day(42),
      priceMinor: 11_600,
    }),
  };
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
  await settle(ctx);
}

/** The parent's "Cancel a week" request from the app: a support request naming the place paid. */
async function refundRequest(
  ctx: DemoContext,
  manager: Principal,
  parent: Principal,
  participantPersonId: string,
  offeringId: string,
): Promise<void> {
  const cases = service(ctx, CasesService);
  const mine = await cases.myCases(parent, { limit: 20 });
  if (mine.items.some((c) => c.category === 'payment')) return;
  const enrollment = (
    await service(ctx, EnrollmentsService).list(parent, {
      participantPersonId,
      offeringId,
      limit: 5,
    })
  ).items[0];
  if (!enrollment) throw new Error('the camp week was not registered');
  const payment = (
    await service(ctx, MoneyReadsService).listPayments(manager, {
      payerPersonId: parent.personId as string,
      status: 'succeeded',
      limit: 20,
    })
  ).items.find((p) => p.amountMinor === 11_600);
  await cases.requestSupport(
    parent,
    {
      category: 'payment',
      title: 'Cancel a week: Winter Break Camp · week 2',
      description: "We're travelling Dec 29 after all — can we drop week 2?",
      subjectPersonId: participantPersonId,
      relatedRecords: [
        { type: 'enrollment', id: enrollment.id },
        ...(payment ? [{ type: 'payment_attempt', id: payment.id }] : []),
      ],
      policyReferences: [],
    },
    null,
  );
}
