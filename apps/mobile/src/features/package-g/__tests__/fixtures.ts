/**
 * Fixtures for the Package G customer screen tests (rentals and parties, memberships,
 * point-of-sale receipts): API bodies typed by the OpenAPI components, stable ids, the fixed test
 * clock (2026-10-24T12:00Z, a Saturday; 5:00 AM in the facility's zone, America/Los_Angeles).
 * Names, amounts and terms are invented test values; no facility fact or policy value is implied.
 */
import type { CapabilityId, Schema } from '@sportspark/api-client';
import { fakeResponse, type FakeHandler } from '@sportspark/api-client/testing';
import { IDS as MONEY_IDS, me } from '../../money/testing/fixtures';
import { TEST_NOW, TEST_SESSION, mePermissions } from '../../../testing/test-app';

export const ZONE = 'America/Los_Angeles';
const T = TEST_NOW.toISOString();

export const G = {
  self: MONEY_IDS.self,
  child: MONEY_IDS.child,
  facility: '0192f1a0-0000-7000-8000-00000000f001',
  rental: '0192f1a0-0000-7000-8000-00000000f101',
  party: '0192f1a0-0000-7000-8000-00000000f102',
  season: '0192f1a0-0000-7000-8000-00000000f103',
  membershipOffering: '0192f1a0-0000-7000-8000-00000000f104',
  membershipNext: '0192f1a0-0000-7000-8000-00000000f105',
  program: '0192f1a0-0000-7000-8000-00000000f201',
  terms: '0192f1a0-0000-7000-8000-00000000f301',
  court1: '0192f1a0-0000-7000-8000-00000000f401',
  court2: '0192f1a0-0000-7000-8000-00000000f402',
  room: '0192f1a0-0000-7000-8000-00000000f403',
  booking: '0192f1a0-0000-7000-8000-00000000f501',
  bookingB: '0192f1a0-0000-7000-8000-00000000f502',
  basket: '0192f1a0-0000-7000-8000-00000000f601',
  basketNew: '0192f1a0-0000-7000-8000-00000000f602',
  enrollment: '0192f1a0-0000-7000-8000-00000000f701',
  membership: '0192f1a0-0000-7000-8000-00000000f702',
  membershipChild: '0192f1a0-0000-7000-8000-00000000f703',
  event: '0192f1a0-0000-7000-8000-00000000f801',
  suspension: '0192f1a0-0000-7000-8000-00000000f901',
  sale: '0192f1a0-0000-7000-8000-00000000fa01',
  saleB: '0192f1a0-0000-7000-8000-00000000fa02',
  policy: '0192f1a0-0000-7000-8000-00000000fb01',
} as const;

export const ok = (body: unknown) => ({ status: 200, body });

export function offering(overrides: Partial<Schema<'Offering'>> = {}): Schema<'Offering'> {
  return {
    id: G.rental,
    programId: G.program,
    facilityId: G.facility,
    facility: { id: G.facility, name: 'North Fields', timezone: ZONE },
    name: 'Court rental',
    description: null,
    kind: 'rental',
    activityType: 'futsal',
    format: null,
    locationLabel: null,
    startsOn: '2026-10-01',
    endsOn: '2027-03-31',
    registrationOpensAt: null,
    registrationClosesAt: null,
    publicationState: 'registration_open',
    ageBand: null,
    capacity: [],
    price: null,
    eligibilityPolicyVersionId: null,
    cancellationPolicyVersionId: null,
    requiredFormPolicyVersionIds: [],
    entitlementDefinitionId: null,
    bookingTermsPolicyVersionId: G.terms,
    staff: null,
    ...overrides,
  } as Schema<'Offering'>;
}

export const partyOffering = (overrides: Partial<Schema<'Offering'>> = {}) =>
  offering({ id: G.party, name: 'Birthday party', kind: 'party', ...overrides });

export function bookingTerms(
  content: Record<string, unknown> = {},
  overrides: Partial<Schema<'PolicyVersion'>> = {},
): Schema<'PolicyVersion'> {
  return {
    id: G.terms,
    kind: 'booking_terms',
    key: 'rental-terms',
    version: 1,
    title: 'Rental terms',
    content: {
      confirmationMode: 'instant',
      installmentPolicyKey: null,
      accessConditions: 'Enter by the north gate.',
      hostResponsibilities: null,
      ...content,
    },
    effectiveFrom: '2026-10-01T00:00:00.000Z',
    effectiveTo: null,
    approvalStatus: 'approved',
    approvedAt: '2026-10-01T00:00:00.000Z',
    retiredAt: null,
    retiredReason: null,
    revision: 1,
    createdAt: T,
    updatedAt: T,
    ...overrides,
  } as Schema<'PolicyVersion'>;
}

/** Saturday Oct 24 in the facility's zone: 10:00 and 11:00 on Court 1, 10:00 on Court 2. */
export function rentalAvailability(
  overrides: Partial<Schema<'BookingAvailability'>> = {},
): Schema<'BookingAvailability'> {
  return {
    offeringId: G.rental,
    timezone: ZONE,
    durationMinutes: 60,
    resourceCount: 1,
    resources: [
      {
        resourceId: G.court1,
        name: 'Court 1',
        freeIntervals: [
          // Before the test clock: never offered.
          { start: '2026-10-24T11:00:00.000Z', end: '2026-10-24T12:00:00.000Z' },
          { start: '2026-10-24T17:00:00.000Z', end: '2026-10-24T18:00:00.000Z' },
          { start: '2026-10-24T18:00:00.000Z', end: '2026-10-24T19:00:00.000Z' },
        ],
      },
      {
        resourceId: G.court2,
        name: 'Court 2',
        freeIntervals: [{ start: '2026-10-24T17:00:00.000Z', end: '2026-10-24T18:00:00.000Z' }],
      },
    ],
    ...overrides,
  };
}

/** A two-hour party at 1:00 PM in the party room. */
export function partyAvailability(): Schema<'BookingAvailability'> {
  return {
    offeringId: G.party,
    timezone: ZONE,
    durationMinutes: 120,
    resourceCount: 1,
    resources: [
      {
        resourceId: G.room,
        name: 'Party room',
        freeIntervals: [{ start: '2026-10-24T20:00:00.000Z', end: '2026-10-24T22:00:00.000Z' }],
      },
    ],
  };
}

export function booking(overrides: Partial<Schema<'Booking'>> = {}): Schema<'Booking'> {
  return {
    id: G.booking,
    kind: 'rental',
    offeringId: G.rental,
    offeringName: 'Court rental',
    facilityId: G.facility,
    timezone: ZONE,
    bookerPersonId: G.self,
    status: 'held',
    outstanding: ['payment'],
    firstStart: '2026-10-24T17:00:00.000Z',
    lastEnd: '2026-10-24T18:00:00.000Z',
    occurrences: [
      {
        start: '2026-10-24T17:00:00.000Z',
        end: '2026-10-24T18:00:00.000Z',
        eventId: G.event,
        resources: [{ id: G.court1, name: 'Court 1' }],
      },
    ],
    guestCount: null,
    equipmentAssetIds: [],
    terms: {
      policyVersionId: G.terms,
      confirmationMode: 'instant',
      accessConditions: 'Enter by the north gate.',
      hostResponsibilities: null,
    },
    basketId: G.basket,
    enrollmentId: G.enrollment,
    decisionReason: null,
    endReason: null,
    revision: 1,
    createdAt: T,
    updatedAt: T,
    ...overrides,
  };
}

export function basket(overrides: Partial<Schema<'Basket'>> = {}): Schema<'Basket'> {
  return {
    id: G.basket,
    ownerPersonId: G.self,
    payerPersonId: G.self,
    createdBy: {
      kind: 'customer',
      accountId: TEST_SESSION.accountId,
      personId: G.self,
      staffRoles: [],
      actorLabel: 'customer',
    },
    assistedByPersonId: null,
    fulfillmentMode: 'all_or_nothing',
    partialAcceptedAt: null,
    status: 'held',
    holdExpiresAt: '2026-10-24T12:20:00.000Z',
    currency: 'USD',
    subtotalMinor: 0,
    approvalPending: false,
    orderRef: null,
    lastOperationId: null,
    lines: [],
    holds: [],
    revision: 2,
    createdAt: T,
    updatedAt: T,
    ...overrides,
  } as Schema<'Basket'>;
}

export function page<T>(items: T[], nextCursor: string | null = null) {
  return { items, nextCursor };
}

export function membership(overrides: Partial<Schema<'Membership'>> = {}): Schema<'Membership'> {
  return {
    enrollmentId: G.membership,
    participantPersonId: G.self,
    offeringId: G.membershipOffering,
    offeringName: 'Adult membership 2026',
    status: 'confirmed',
    termStartsAt: '2026-01-01T08:00:00.000Z',
    termEndsAt: '2026-12-31T08:00:00.000Z',
    attendance: {
      mode: 'included_sessions',
      limit: { count: 8, period: 'month', weekStartsOn: null },
      appliesTo: { offeringIds: [G.season], programIds: [] },
    },
    renewedFromEnrollmentId: null,
    suspensions: [],
    usage: [{ periodKey: 'month:2026-10', usedCount: 3, limitCount: 8 }],
    revision: 2,
    createdAt: '2026-01-01T08:00:00.000Z',
    ...overrides,
  };
}

export function suspension(
  overrides: Partial<Schema<'MembershipSuspension'>> = {},
): Schema<'MembershipSuspension'> {
  return {
    id: G.suspension,
    enrollmentId: G.membershipChild,
    participantPersonId: G.child,
    from: '2026-10-20T07:00:00.000Z',
    until: '2026-11-03T08:00:00.000Z',
    reason: 'Injury',
    status: 'active',
    endedAt: null,
    endedReason: null,
    revision: 1,
    createdAt: T,
    updatedAt: T,
    ...overrides,
  };
}

export function receipt(overrides: Partial<Schema<'PosReceipt'>> = {}): Schema<'PosReceipt'> {
  return {
    saleId: G.sale,
    saleNumber: 'S-1042',
    facilityId: G.facility,
    status: 'paid',
    currency: 'USD',
    lines: [
      {
        name: 'Water bottle',
        kind: 'merchandise',
        quantity: 2,
        unitPriceMinor: 300,
        baseMinor: 600,
        charges: [
          {
            policyVersionId: G.policy,
            code: 'sales_tax',
            label: 'Sales tax',
            kind: 'tax',
            amountMinor: 50,
          },
        ],
        lineTotalMinor: 650,
      },
    ],
    subtotalMinor: 600,
    charges: [{ code: 'sales_tax', label: 'Sales tax', kind: 'tax', amountMinor: 50 }],
    totalMinor: 650,
    tenders: [{ kind: 'card', amountMinor: 650 }],
    returns: [],
    paidAt: '2026-10-23T18:30:00.000Z',
    ...overrides,
  };
}

export function facility(): Schema<'FacilitySummary'> {
  return {
    id: G.facility,
    slug: 'north-fields',
    name: 'North Fields',
    timezone: ZONE,
    status: 'active',
    address: null,
    inStaffScope: null,
  };
}

/** `GET /me` (the signed-in adult with a child) and the child's name. */
export function peopleRoutes(): Record<string, FakeHandler> {
  return {
    'GET /me': ok(me()),
    'GET /person-names': () =>
      fakeResponse(200, {
        items: [
          {
            personId: G.child,
            canonicalPersonId: G.child,
            givenName: 'Sam',
            familyName: 'Rivera',
            displayName: 'Sam Rivera',
            kind: 'child',
          },
        ],
      }),
  };
}

/** `GET /me/permissions` with these capability switches on (every other one off, DEC-016). */
export const switchesOn = (...enabled: CapabilityId[]) => ({
  'GET /me/permissions': mePermissions({ enabled }),
});
