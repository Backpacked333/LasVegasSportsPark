import type { AddBasketLineInput, CheckoutPayment, Principal } from '@sportspark/contracts';
import { WaiversService } from '../../modules/catalog';
import {
  ApplicationsService,
  BasketsService,
  EnrollmentsService,
  WaitlistService,
} from '../../modules/enrollment';
import {
  CheckoutService,
  FakePaymentProvider,
  FakePaymentTokens,
  MoneyReadsService,
  ObligationsService,
  QuotesService,
  RefundsService,
} from '../../modules/finance';
import { PeopleService } from '../../modules/identity';
import { WAIVER_KEY, type DemoCatalog, type DemoOffering } from './catalog';
import { calendarOf, optional, service, settle, type DemoContext } from './context';
import type { DemoFamily, DemoStaff } from './people';

/**
 * Families register the way they would (SPK-REG-001 to 010): a basket, a hold, a quote and a
 * checkout paid through the fake payment provider, by the parent in the app or by the front desk
 * for them. The result is a registration queue with every state in it (confirmed, awaiting
 * approval, waitlisted, canceled), paid orders, one declined card, one payment whose outcome is
 * unknown, one refund still with the provider and one amount the seeded parent still owes.
 * Waivers (SPK-REG-011) are accepted digitally by most families, entered from paper by the desk
 * for one, and left missing for two children so each state shows.
 */
type Line = Omit<AddBasketLineInput, 'policyReferences' | 'quantity'>;

interface RegistrationSpec {
  /** Who acts: the parent (the default) or a staff member for them. */
  actor?: Principal;
  family: DemoFamily;
  lines: Line[];
  payment: CheckoutPayment;
}

const card = (token: string): CheckoutPayment => ({
  method: 'provider',
  paymentMethodToken: token,
});

export async function seedRegistrations(
  ctx: DemoContext,
  staff: DemoStaff,
  families: DemoFamily[],
  catalog: DemoCatalog,
): Promise<void> {
  const baskets = service(ctx, BasketsService);
  const quotes = service(ctx, QuotesService);
  const checkouts = service(ctx, CheckoutService);
  const enrollments = service(ctx, EnrollmentsService);
  const waivers = service(ctx, WaiversService);
  const calendar = calendarOf(ctx);
  const manager = staff.manager.principal;
  const desk = staff.desk.principal;
  const family = (key: string): DemoFamily => {
    const found = families.find((f) => f.key === key);
    if (!found) throw new Error(`no demo family ${key}`);
    return found;
  };
  const child = (key: string, index = 0): string => {
    const found = family(key).children[index];
    if (!found) throw new Error(`the demo family ${key} has no child ${index}`);
    return found.personId;
  };

  // The seeded child has no date of birth; the age band of a class needs one (§4.5).
  const people = service(ctx, PeopleService);
  const devChild = await people.getPerson(ctx.system, child('dev'));
  if (!devChild.dateOfBirth) {
    await people.updatePerson(
      ctx.system,
      devChild.id,
      {
        dateOfBirth: `${Number(calendar.today.slice(0, 4)) - 8}-03-14`,
        expectedRevision: devChild.revision,
        policyReferences: [],
      },
      null,
    );
  }

  // Waivers first, as a family would be asked at registration: digital for most, one from paper.
  const paperChild = child('dune');
  const missing = new Set([child('dev'), child('heath')]);
  for (const f of families) {
    for (const c of f.children) {
      if (missing.has(c.personId)) continue;
      const status = await waivers.personWaivers(manager, c.personId);
      if (status.waivers.some((w) => w.policyKey === WAIVER_KEY && w.acceptance)) continue;
      if (c.personId === paperChild) {
        await waivers.accept(
          desk,
          {
            subjectPersonId: c.personId,
            policyKey: WAIVER_KEY,
            method: 'paper',
            signedByPersonId: f.adult.personId,
            paperDatedOn: calendar.day(-9),
            evidence: { note: 'Signed on paper at the front desk; filed in the waiver binder.' },
            policyReferences: [],
          },
          null,
        );
      } else {
        await waivers.accept(
          f.adult.principal,
          {
            subjectPersonId: c.personId,
            policyKey: WAIVER_KEY,
            method: 'digital',
            evidence: {},
            policyReferences: [],
          },
          null,
        );
      }
    }
  }

  const hasPlace = async (personId: string, offering: DemoOffering): Promise<boolean> => {
    const listed = await enrollments.list(manager, {
      participantPersonId: personId,
      offeringId: offering.id,
      limit: 50,
    });
    return listed.items.length > 0;
  };

  /** A basket, a hold, a quote and a checkout; skipped when the first line is already held. */
  const register = async (spec: RegistrationSpec): Promise<void> => {
    const first = spec.lines[0] as Line;
    const offering = Object.values(catalog).find(
      (o): o is DemoOffering => typeof o === 'object' && 'id' in o && o.id === first.offeringId,
    ) as DemoOffering;
    if (await hasPlace(first.participantPersonId, offering)) return;
    const actor = spec.actor ?? spec.family.adult.principal;
    let basket = await baskets.create(
      actor,
      {
        ownerPersonId: spec.family.adult.personId,
        fulfillmentMode: 'all_or_nothing',
        acceptPartialFulfillment: false,
        policyReferences: [],
      },
      null,
    );
    for (const line of spec.lines) {
      basket = await baskets.addLine(
        actor,
        basket.id,
        { ...line, quantity: 1, policyReferences: [] },
        null,
      );
    }
    basket = await baskets.hold(
      actor,
      basket.id,
      { expectedRevision: basket.revision, policyReferences: [] },
      null,
    );
    const quote = await quotes.create(
      actor,
      {
        basketId: basket.id,
        discountCodes: [],
        creditIds: [],
        paymentPlan: { kind: 'full' },
        policyReferences: [],
      },
      null,
    );
    await checkouts.create(
      actor,
      {
        quoteId: quote.id,
        payment: spec.payment,
        authorizeFutureInstallments: false,
        policyReferences: [],
      },
      null,
    );
    await settle(ctx);
  };
  const youth = (personId: string, offering: DemoOffering, extra: Partial<Line> = {}): Line => ({
    participantPersonId: personId,
    offeringId: offering.id,
    intent: 'youth',
    ...extra,
  });
  const paid = card(FakePaymentTokens.succeed);
  const cash = (reference: string): CheckoutPayment => ({
    method: 'cash',
    tenderKind: 'cash',
    facilityId: ctx.facilityId,
    evidence: { reference },
  });

  // The seeded parent: a class today (SPK-REG-001), paid by card in the app.
  await register({
    family: family('dev'),
    lines: [youth(child('dev'), catalog.termClass)],
    payment: paid,
  });
  await register({
    family: family('alder'),
    lines: [youth(child('alder'), catalog.termClass)],
    payment: paid,
  });
  // Two siblings in one basket: one class by the term, one by the classes still to come.
  await register({
    family: family('birch'),
    lines: [
      youth(child('birch', 0), catalog.perSessionClass),
      youth(child('birch', 1), catalog.termClass),
    ],
    payment: paid,
  });
  // The front desk registers a family and takes cash (assisted registration).
  await register({
    actor: desk,
    family: family('dune'),
    lines: [youth(child('dune'), catalog.termClass)],
    payment: cash('Till 1, receipt 1041'),
  });
  await register({
    family: family('elm'),
    lines: [
      youth(child('elm', 0), catalog.perSessionClass),
      youth(child('elm', 1), catalog.termClass),
    ],
    payment: paid,
  });
  // The member: the membership first, then the class at the member price (SPK-PAY-015).
  await register({
    family: family('cedar'),
    lines: [
      {
        participantPersonId: child('cedar'),
        offeringId: catalog.membership.id,
        intent: 'membership',
      },
    ],
    payment: paid,
  });
  await register({
    family: family('cedar'),
    lines: [youth(child('cedar'), catalog.memberClass)],
    payment: paid,
  });
  // A second member who is not in the class yet: the desk can quote her the member price.
  await register({
    family: family('birch'),
    lines: [
      {
        participantPersonId: child('birch'),
        offeringId: catalog.membership.id,
        intent: 'membership',
      },
    ],
    payment: paid,
  });
  // The same class at the standard price, later canceled with a refund.
  await register({
    family: family('juniper'),
    lines: [youth(child('juniper'), catalog.memberClass)],
    payment: paid,
  });
  // The small clinic fills up; the next family waits (SPK-REG-008).
  await register({
    family: family('fern'),
    lines: [youth(child('fern'), catalog.smallClass)],
    payment: paid,
  });
  await register({
    family: family('heath'),
    lines: [youth(child('heath'), catalog.smallClass)],
    payment: paid,
  });

  // The camp (SPK-PAY-014, SPK-REG-012): a full week with lunch and a jersey; single days.
  const tier = (code: string): string => {
    const found = catalog.camp.rule?.tiers.find((t) => t.code === code);
    if (!found) throw new Error(`the camp has no tier ${code}`);
    return found.id;
  };
  const campDays = catalog.camp.sessions.map((s) => s.id);
  await register({
    family: family('kestrel'),
    lines: [
      youth(child('kestrel'), catalog.camp, {
        priceTierId: tier('full_week'),
        addons: [
          { addonId: catalog.camp.addons.lunch, sessionIds: campDays.slice(0, 3) },
          { addonId: catalog.camp.addons.teamPhoto },
        ],
        uniform: { offeringUniformId: catalog.camp.uniformId, size: 'Youth M' },
      }),
    ],
    payment: paid,
  });
  await register({
    actor: desk,
    family: family('grove'),
    lines: [
      youth(child('grove'), catalog.camp, {
        priceTierId: tier('single_day'),
        selectedSessionIds: campDays.slice(0, 1),
        addons: [{ addonId: catalog.camp.addons.earlyDropOff, sessionIds: campDays.slice(0, 1) }],
      }),
    ],
    payment: cash('Till 1, receipt 1042'),
  });
  await register({
    family: family('elm'),
    lines: [
      youth(child('elm', 0), catalog.camp, {
        priceTierId: tier('full_week'),
        addons: [{ addonId: catalog.camp.addons.earlyDropOff, sessionIds: campDays }],
        uniform: { offeringUniformId: catalog.camp.uniformId, size: 'Youth L' },
      }),
    ],
    payment: paid,
  });

  // Waitlisted: the clinic is full, so the next child joins the list.
  await optional(ctx, 'the waitlist entry on the goalkeeper clinic', async () => {
    const waitlist = service(ctx, WaitlistService);
    const waiting = await waitlist.list(manager, { offeringId: catalog.smallClass.id });
    if (waiting.some((w) => w.participantPersonId === child('isle'))) return;
    await waitlist.join(
      family('isle').adult.principal,
      {
        offeringId: catalog.smallClass.id,
        participantPersonId: child('isle'),
        intent: 'youth',
        preferences: {},
        policyReferences: [],
      },
      null,
    );
  });

  // Awaiting approval: the advanced squad takes players only after a coach has seen them.
  await optional(ctx, 'the application awaiting approval', async () => {
    const applications = service(ctx, ApplicationsService);
    for (const key of ['alder', 'fern']) {
      const listed = await applications.list(manager, {
        offeringId: catalog.approvalClass.id,
        participantPersonId: child(key),
        limit: 10,
      });
      if (listed.items.length > 0) continue;
      await applications.create(
        family(key).adult.principal,
        {
          offeringId: catalog.approvalClass.id,
          participantPersonId: child(key),
          intent: 'youth',
          notes: 'Played two seasons of futsal; would like to try the advanced squad.',
          policyReferences: [],
        },
        null,
      );
    }
  });

  // Canceled (SPK-REG-010): the family accepts the refund the policy grants. Finance owns the
  // money side of a cancellation, so an exception waits in its queue; the refund finance then
  // issues is still with the provider (SPK-PAY-008).
  await optional(ctx, 'the canceled registration with a refund in flight', async () => {
    const parent = family('juniper');
    const listed = await enrollments.list(manager, {
      participantPersonId: child('juniper'),
      offeringId: catalog.memberClass.id,
      limit: 10,
    });
    const place = listed.items.find((e) => e.status === 'confirmed');
    if (place) {
      const preview = await enrollments.cancellationPreview(parent.adult.principal, place.id);
      const consequence = preview.financialConsequence;
      await enrollments.cancel(
        parent.adult.principal,
        place.id,
        {
          reason: 'Moving away before the term ends',
          expectedRevision: place.revision,
          acceptedConsequence: {
            kind: consequence.kind,
            amountMinor: consequence.amountMinor,
            currency: consequence.currency,
          },
          policyReferences: [],
        },
        null,
      );
      await settle(ctx);
    }
    const reads = service(ctx, MoneyReadsService);
    const payments = await reads.listPayments(manager, {
      payerPersonId: parent.adult.personId,
      status: 'succeeded',
      limit: 10,
    });
    const payment = payments.items[0];
    if (!payment) return;
    const refunds = await reads.listRefunds(manager, { paymentAttemptId: payment.id, limit: 10 });
    if (refunds.items.length > 0) return;
    // The fake provider answers "processing": the refund is requested and not yet confirmed.
    service(ctx, FakePaymentProvider).scriptRefunds('processing');
    await service(ctx, RefundsService).request(
      manager,
      payment.id,
      {
        amountMinor: 8_000,
        reason: 'Half of the term price, as the cancellation terms grant',
        policyReferences: [],
      },
      null,
    );
    await settle(ctx);
  });

  // A declined card and a payment whose outcome is unknown, so Finance has exceptions to show.
  const troubled = async (key: string, token: string, offering: DemoOffering): Promise<void> => {
    const parent = family(key);
    const participant = parent.children[0]?.personId as string;
    const earlier = await service(ctx, ApplicationsService).list(manager, {
      offeringId: offering.id,
      participantPersonId: participant,
      limit: 10,
    });
    if (earlier.items.length > 0) return;
    await register({
      family: parent,
      lines: [youth(participant, offering)],
      payment: card(token),
    });
  };
  await optional(ctx, 'the declined card payment', () =>
    troubled('grove', FakePaymentTokens.decline, catalog.perSessionClass),
  );
  await optional(ctx, 'the payment with an unknown outcome', () =>
    troubled('isle', FakePaymentTokens.timeout, catalog.termClass),
  );

  // What the seeded parent still owes: a jersey ordered at the desk, due in a week.
  await optional(ctx, "the seeded parent's unpaid item", async () => {
    const obligations = service(ctx, ObligationsService);
    const parent = family('dev');
    const description = 'Team jersey ordered at the front desk';
    const owed = await obligations.list(manager, {
      debtorPersonId: parent.adult.personId,
      limit: 50,
    });
    // The parent's paid registration is an obligation too: the unpaid one is found by what it says.
    if (owed.items.some((o) => o.description === description)) return;
    await obligations.create(
      manager,
      {
        debtor: { kind: 'person', personId: parent.adult.personId },
        mode: 'individual',
        amountMinor: 2_200,
        currency: 'USD',
        dueAt: calendar.iso(7, '18:00'),
        description,
        source: { kind: 'manual' },
        policyReferences: [],
      },
      null,
    );
  });
  await settle(ctx);
}
