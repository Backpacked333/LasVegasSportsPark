import type { Booking, Principal } from '@sportspark/contracts';
import { WaiversService } from '../../modules/catalog';
import { BookingRostersService } from '../../modules/enrollment/services/booking-rosters.service';
import { BookingsService } from '../../modules/enrollment/services/bookings.service';
import { CheckoutService, FakePaymentTokens, QuotesService } from '../../modules/finance';
import { WAIVER_KEY, type DemoCatalog } from './catalog';
import { calendarOf, optional, service, settle, type DemoContext } from './context';
import { seedAdults, type DemoAdult, type DemoStaff } from './people';
import type { DemoSpaces } from './spaces';

/**
 * Field rentals this week (SPK-COND-003): the desk enters a rental for a renter, who pays; a
 * second renter books half the field online and has not paid yet. The first rental has a group
 * roster (SPK-COND-005): a member who accepted the waiver, one who has not, and open invitations,
 * one of them to the seeded parent so the customer app has an invitation to answer.
 */
export interface DemoRentals {
  rosterBookingId: string | null;
}

export async function seedRentals(
  ctx: DemoContext,
  staff: DemoStaff,
  spaces: DemoSpaces,
  catalog: DemoCatalog,
  parent: Principal,
): Promise<DemoRentals> {
  const bookings = service(ctx, BookingsService);
  const rosters = service(ctx, BookingRostersService);
  const waivers = service(ctx, WaiversService);
  const calendar = calendarOf(ctx);
  const desk = staff.desk.principal;
  const renters = await seedAdults(ctx, [
    { key: 'renter-1', givenName: 'Sam', familyName: 'Ostrander-Sample' },
    { key: 'renter-2', givenName: 'Noor', familyName: 'Pelham-Sample' },
    { key: 'renter-guest-1', givenName: 'Leo', familyName: 'Quince-Sample' },
    { key: 'renter-guest-2', givenName: 'Ada', familyName: 'Rill-Sample' },
  ]);
  const renter = (key: string): DemoAdult => renters.get(key) as DemoAdult;

  const existing = (
    await bookings.list(desk, { facilityId: ctx.facilityId, kind: 'rental', limit: 200 })
  ).items;
  const book = async (
    actor: Principal,
    booker: DemoAdult,
    day: number,
    from: string,
    to: string,
    resourceId: string,
    pay: boolean,
  ): Promise<Booking> => {
    const start = calendar.iso(day, from);
    const known = existing.find(
      (b) => b.bookerPersonId === booker.personId && b.firstStart === start,
    );
    if (known) return known;
    const created = await bookings.create(
      actor,
      {
        offeringId: catalog.rental.id,
        bookerPersonId: booker.personId,
        start,
        end: calendar.iso(day, to),
        resourceIds: [resourceId],
        policyReferences: [],
      },
      null,
    );
    if (pay && created.basketId) {
      const quote = await service(ctx, QuotesService).create(
        booker.principal,
        {
          basketId: created.basketId,
          discountCodes: [],
          creditIds: [],
          paymentPlan: { kind: 'full' },
          policyReferences: [],
        },
        null,
      );
      await service(ctx, CheckoutService).create(
        booker.principal,
        {
          quoteId: quote.id,
          payment: { method: 'provider', paymentMethodToken: FakePaymentTokens.succeed },
          authorizeFutureInstallments: false,
          policyReferences: [],
        },
        null,
      );
      await settle(ctx);
    }
    return created;
  };

  // Tomorrow evening: the whole of Field 1, entered at the desk and paid by the renter.
  const main = await book(desk, renter('renter-1'), 1, '19:00', '20:30', spaces.field1, true);
  // Later this week: one half, booked online and paid.
  await optional(ctx, 'the second rental booking', () =>
    book(
      renter('renter-2').principal,
      renter('renter-2'),
      3,
      '18:30',
      '19:30',
      spaces.field1South,
      true,
    ),
  );
  // Tonight (or the day after tomorrow when tonight has passed): the other half, booked online and
  // not paid yet. A booking starts in the future.
  const tonight = calendar.at(0, '20:00').getTime() > ctx.clock.now().getTime() + 5 * 60_000;
  await optional(ctx, 'the unpaid rental booking', () =>
    book(
      renter('renter-2').principal,
      renter('renter-2'),
      tonight ? 0 : 2,
      '20:00',
      '21:00',
      spaces.field1North,
      false,
    ),
  );

  await optional(ctx, 'the rental group roster', async () => {
    const roster = await rosters.roster(desk, main.id);
    if (roster.members.length > 0) return;
    const organizer = renter('renter-1');
    // The renter accepts the waiver for himself, then lists himself and a friend who has not.
    await waivers.accept(
      organizer.principal,
      {
        subjectPersonId: organizer.personId,
        policyKey: WAIVER_KEY,
        method: 'digital',
        evidence: {},
        policyReferences: [],
      },
      null,
    );
    await rosters.addMember(
      organizer.principal,
      main.id,
      { personId: organizer.personId, policyReferences: [] },
      null,
    );
    await rosters.addMember(
      desk,
      main.id,
      { personId: renter('renter-guest-1').personId, policyReferences: [] },
      null,
    );
    // Two open invitations: a friend, and the seeded parent (to answer in the customer app).
    for (const recipientPersonId of [renter('renter-guest-2').personId, parent.personId]) {
      if (!recipientPersonId) continue;
      await rosters.invite(
        organizer.principal,
        main.id,
        {
          recipientPersonId,
          message: 'Five-a-side tomorrow at 7 pm on Field 1. Join the roster so the desk has you.',
          expiresInHours: 72,
          policyReferences: [],
        },
        null,
      );
    }
  });
  await settle(ctx);
  return { rosterBookingId: main.id };
}
