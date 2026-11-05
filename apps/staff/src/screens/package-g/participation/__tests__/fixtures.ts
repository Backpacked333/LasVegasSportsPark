/**
 * Records for the Package G participation screen tests (SCR-S-51 to SCR-S-54), in the API's shapes
 * (packages/contracts/src/api/enrollment-package-g.ts, catalog.ts). Deterministic ids and instants
 * only; names are invented and no child data beyond a name is used.
 */
import type { Schema } from '@sportspark/api-client';
import { apiErrorBody, fakeResponse, type FakeHandler } from '@sportspark/api-client/testing';
import { FACILITY_A } from '../../../../testing/test-app';

export const ZONE = 'America/Los_Angeles';

export const BOOKER_ID = '0192f1a0-0000-7000-8000-0000000000b1';
export const MEMBER_ID = '0192f1a0-0000-7000-8000-0000000000b2';
export const RENTAL_OFFERING_ID = '0192f1a0-0000-7000-8000-0000000001a1';
export const PARTY_OFFERING_ID = '0192f1a0-0000-7000-8000-0000000001a2';
export const MEMBERSHIP_OFFERING_ID = '0192f1a0-0000-7000-8000-0000000001a3';
export const MEMBERSHIP_NEXT_OFFERING_ID = '0192f1a0-0000-7000-8000-0000000001a4';
export const PACKAGE_OFFERING_ID = '0192f1a0-0000-7000-8000-0000000001a5';
export const PICKUP_OFFERING_ID = '0192f1a0-0000-7000-8000-0000000001a6';
export const PROGRAM_ID = '0192f1a0-0000-7000-8000-0000000001b1';
export const RENTAL_DEFINITION_ID = '0192f1a0-0000-7000-8000-0000000001c1';
export const PARTY_DEFINITION_ID = '0192f1a0-0000-7000-8000-0000000001c2';
export const MEMBERSHIP_DEFINITION_ID = '0192f1a0-0000-7000-8000-0000000001c3';
export const PACKAGE_DEFINITION_ID = '0192f1a0-0000-7000-8000-0000000001c4';
export const TERMS_ID = '0192f1a0-0000-7000-8000-0000000001d1';
export const RESOURCE_A = '0192f1a0-0000-7000-8000-0000000001e1';
export const RESOURCE_B = '0192f1a0-0000-7000-8000-0000000001e2';
export const ASSET_ID = '0192f1a0-0000-7000-8000-0000000001e3';
export const BOOKING_ID = '0192f1a0-0000-7000-8000-0000000002a1';
export const PARTY_BOOKING_ID = '0192f1a0-0000-7000-8000-0000000002a2';
export const BASKET_ID = '0192f1a0-0000-7000-8000-0000000002b1';
export const ENROLLMENT_ID = '0192f1a0-0000-7000-8000-0000000002c1';
export const MEMBERSHIP_ENROLLMENT_ID = '0192f1a0-0000-7000-8000-0000000002c2';
export const PACKAGE_ENROLLMENT_ID = '0192f1a0-0000-7000-8000-0000000002c3';
export const ENTITLEMENT_ID = '0192f1a0-0000-7000-8000-0000000002d1';
export const REDEMPTION_ID = '0192f1a0-0000-7000-8000-0000000002d2';
export const REVERSAL_ID = '0192f1a0-0000-7000-8000-0000000002d3';
export const SESSION_BOOKING_ID = '0192f1a0-0000-7000-8000-0000000002e1';
export const SESSION_ID = '0192f1a0-0000-7000-8000-0000000002e2';
export const SUSPENSION_ID = '0192f1a0-0000-7000-8000-0000000002f1';
export const EVENT_ID = '0192f1a0-0000-7000-8000-0000000003a1';
export const REQUIREMENT_ID = '0192f1a0-0000-7000-8000-0000000003b1';
export const ASSIGNMENT_ID = '0192f1a0-0000-7000-8000-0000000003c1';
export const HOST_ID = '0192f1a0-0000-7000-8000-0000000000b3';
export const CORRELATION = 'corr-pg-1';

export const ok = (body: unknown): FakeHandler => ({ status: 200, body });
export const created = (body: unknown): FakeHandler => ({ status: 201, body });
export const page = (items: unknown[], nextCursor: string | null = null): FakeHandler =>
  ok({ items, nextCursor });
export const apiError = (
  status: number,
  code: string,
  overrides: Parameters<typeof apiErrorBody>[1] = {},
): FakeHandler => ({
  status,
  body: apiErrorBody(code, { correlationId: CORRELATION, ...overrides }),
});

export function booking(overrides: Partial<Schema<'Booking'>> = {}): Schema<'Booking'> {
  return {
    id: BOOKING_ID,
    kind: 'rental',
    offeringId: RENTAL_OFFERING_ID,
    offeringName: 'Pitch 1 hourly rental',
    facilityId: FACILITY_A,
    timezone: ZONE,
    bookerPersonId: BOOKER_ID,
    status: 'requested',
    outstanding: ['approval'],
    firstStart: '2026-11-02T02:00:00.000Z',
    lastEnd: '2026-11-02T03:00:00.000Z',
    occurrences: [
      {
        start: '2026-11-02T02:00:00.000Z',
        end: '2026-11-02T03:00:00.000Z',
        eventId: null,
        resources: [{ id: RESOURCE_A, name: 'Pitch 1' }],
      },
    ],
    guestCount: null,
    equipmentAssetIds: [],
    terms: {
      policyVersionId: TERMS_ID,
      confirmationMode: 'request',
      accessConditions: 'Members gate opens 15 minutes before.',
      hostResponsibilities: null,
    },
    basketId: null,
    enrollmentId: null,
    decisionReason: null,
    endReason: null,
    revision: 3,
    createdAt: '2026-10-20T17:00:00.000Z',
    updatedAt: '2026-10-20T17:00:00.000Z',
    ...overrides,
  };
}

export function partyBooking(overrides: Partial<Schema<'Booking'>> = {}): Schema<'Booking'> {
  return booking({
    id: PARTY_BOOKING_ID,
    kind: 'party',
    offeringId: PARTY_OFFERING_ID,
    offeringName: 'Birthday party package',
    status: 'awaiting_staff',
    outstanding: ['staffing'],
    guestCount: 12,
    equipmentAssetIds: [ASSET_ID],
    terms: {
      policyVersionId: TERMS_ID,
      confirmationMode: 'instant',
      accessConditions: null,
      hostResponsibilities: 'The host runs games and serves cake.',
    },
    // Reserved: the occurrence has its scheduling event, which carries the staff requirements.
    occurrences: [
      {
        start: '2026-11-02T02:00:00.000Z',
        end: '2026-11-02T03:00:00.000Z',
        eventId: EVENT_ID,
        resources: [{ id: RESOURCE_A, name: 'Pitch 1' }],
      },
    ],
    // The API sets both when the booking is held, before any payment, and keeps them after.
    basketId: BASKET_ID,
    enrollmentId: ENROLLMENT_ID,
    ...overrides,
  });
}

/** `GET /assignment-requirements` of a party event: one host, `accepted` of them accepted. */
export function hostRequirement(
  coverage: Partial<Schema<'RequirementCoverage'>> = {},
): Schema<'AssignmentRequirement'> {
  return {
    id: REQUIREMENT_ID,
    facilityId: FACILITY_A,
    targetType: 'event',
    targetId: EVENT_ID,
    offeringId: null,
    kind: 'supervisor',
    role: 'party_host',
    requiredCount: 1,
    mustBeAccepted: true,
    requiredQualifications: ['first_aid'],
    coverage: { accepted: 0, offered: 0, proposed: 0, uncoveredSlots: [1], ...coverage },
    revision: 1,
    createdAt: '2026-10-20T17:00:00.000Z',
  };
}

/** One host assignment on the party event, in the staff list shape. */
export function hostAssignment(
  overrides: Partial<Schema<'StaffAssignment'>> = {},
): Schema<'StaffAssignment'> {
  return {
    id: ASSIGNMENT_ID,
    facilityId: FACILITY_A,
    personId: HOST_ID,
    kind: 'supervisor',
    targetType: 'event',
    targetId: EVENT_ID,
    offeringId: null,
    schedulingEventId: EVENT_ID,
    targetTitle: 'Birthday party package',
    role: 'party_host',
    slot: 1,
    engagement: 'regular',
    status: 'accepted',
    scheduledStart: '2026-11-02T02:00:00.000Z',
    scheduledEnd: '2026-11-02T03:00:00.000Z',
    turnaroundMinutes: 0,
    committedUntil: '2026-11-02T03:00:00.000Z',
    replacesAssignmentId: null,
    offeredAt: '2026-10-21T17:00:00.000Z',
    respondedAt: '2026-10-21T18:00:00.000Z',
    acceptedAt: '2026-10-21T18:00:00.000Z',
    declinedAt: null,
    declineReason: null,
    withdrawnAt: null,
    withdrawnReason: null,
    completedAt: null,
    access: {
      status: 'not_applicable',
      staffMembershipId: null,
      from: null,
      until: null,
      active: false,
    },
    revision: 2,
    createdAt: '2026-10-21T17:00:00.000Z',
    updatedAt: '2026-10-21T18:00:00.000Z',
    availableActions: [],
    ...overrides,
  };
}

export function offering(
  overrides: Partial<Schema<'OfferingListItem'>> = {},
): Schema<'OfferingListItem'> {
  return {
    id: RENTAL_OFFERING_ID,
    programId: PROGRAM_ID,
    facilityId: FACILITY_A,
    facility: { id: FACILITY_A, name: 'North Park', timezone: ZONE },
    name: 'Pitch 1 hourly rental',
    description: null,
    kind: 'rental',
    activityType: 'soccer',
    format: null,
    locationLabel: null,
    startsOn: '2026-09-01',
    endsOn: '2027-08-31',
    registrationOpensAt: null,
    registrationClosesAt: null,
    publicationState: 'registration_open',
    ageBand: {},
    capacity: [],
    price: null,
    eligibilityPolicyVersionId: null,
    cancellationPolicyVersionId: null,
    requiredFormPolicyVersionIds: [],
    entitlementDefinitionId: RENTAL_DEFINITION_ID,
    bookingTermsPolicyVersionId: TERMS_ID,
    ...overrides,
  };
}

export function definition(
  overrides: Partial<Schema<'EntitlementDefinition'>> = {},
): Schema<'EntitlementDefinition'> {
  return {
    id: RENTAL_DEFINITION_ID,
    name: 'Pitch rental',
    description: null,
    kind: 'rental_resource',
    scope: {
      resources: { resourceIds: [RESOURCE_A, RESOURCE_B], count: 1 },
      staffing: [],
    },
    equivalenceScope: 'none',
    equivalenceRule: {},
    status: 'active',
    revision: 1,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

export const PARTY_DEFINITION = definition({
  id: PARTY_DEFINITION_ID,
  name: 'Birthday party',
  kind: 'party_package',
  scope: {
    durationMinutes: 120,
    guestLimit: 20,
    resources: { resourceIds: [RESOURCE_A], count: 1 },
    staffing: [{ kind: 'supervisor', role: 'party_host', count: 1, qualifications: ['first_aid'] }],
    equipmentAssetIds: [ASSET_ID],
  },
});

export const MEMBERSHIP_DEFINITION = definition({
  id: MEMBERSHIP_DEFINITION_ID,
  name: 'Adult membership',
  kind: 'membership_benefit',
  scope: {
    attendance: {
      mode: 'included_sessions',
      appliesTo: { offeringIds: [PICKUP_OFFERING_ID] },
      limit: { count: 2, period: 'week', weekStartsOn: 1 },
    },
    term: { kind: 'from_confirmation', lengthDays: 365 },
    renewal: { noticeLeadDays: 30 },
  },
});

export const PACKAGE_DEFINITION = definition({
  id: PACKAGE_DEFINITION_ID,
  name: 'Ten-session pass',
  kind: 'package_credits',
  scope: {
    credits: 10,
    appliesTo: { offeringIds: [PICKUP_OFFERING_ID] },
    expiry: { kind: 'days_after_issue', days: 180 },
  },
});

export function bookingTerms(
  overrides: Partial<Schema<'PolicyVersion'>> = {},
  content: Record<string, unknown> = {},
): Schema<'PolicyVersion'> {
  return {
    id: TERMS_ID,
    kind: 'booking_terms',
    key: 'pol-040-rentals',
    version: 2,
    title: 'Rental terms',
    content: {
      confirmationMode: 'request',
      installmentPolicyKey: 'pol-005-deposit',
      setupMinutes: 15,
      accessConditions: 'Members gate opens 15 minutes before.',
      hostResponsibilities: null,
      ...content,
    },
    effectiveFrom: '2026-09-01T07:00:00.000Z',
    effectiveTo: null,
    approvalStatus: 'approved',
    approvedAt: '2026-08-30T17:00:00.000Z',
    retiredAt: null,
    retiredReason: null,
    revision: 1,
    createdAt: '2026-08-29T17:00:00.000Z',
    updatedAt: '2026-08-30T17:00:00.000Z',
    ...overrides,
  };
}

/**
 * `GET /person-names`: every known name, whatever ids were asked (the fake keeps only the last
 * repeated query value; the screen maps the answer by personId, so extra names are harmless).
 */
export function personNames(names: Record<string, [given: string, family: string]>): FakeHandler {
  return ok({
    items: Object.entries(names).map(([id, [givenName, familyName]]) => ({
      personId: id,
      canonicalPersonId: id,
      givenName,
      familyName,
      displayName: `${givenName} ${familyName}`,
      kind: 'adult',
    })),
  });
}

export const NAMES = personNames({
  [BOOKER_ID]: ['Rosa', 'Diaz'],
  [MEMBER_ID]: ['Ken', 'Ito'],
  [HOST_ID]: ['Sam', 'Lee'],
});

/** Reads every booking screen makes besides the booking itself. */
export function catalogRoutes(): Record<string, FakeHandler> {
  return {
    'GET /person-names': NAMES,
    'GET /offerings/{id}': (request) => {
      const byId: Record<string, Schema<'OfferingListItem'>> = {
        [RENTAL_OFFERING_ID]: offering(),
        [PARTY_OFFERING_ID]: offering({
          id: PARTY_OFFERING_ID,
          kind: 'party',
          name: 'Birthday party package',
          entitlementDefinitionId: PARTY_DEFINITION_ID,
        }),
        [PICKUP_OFFERING_ID]: offering({
          id: PICKUP_OFFERING_ID,
          kind: 'pickup',
          name: 'Friday pickup',
          entitlementDefinitionId: null,
          bookingTermsPolicyVersionId: null,
        }),
      };
      const found = byId[request.params.id ?? ''];
      return found
        ? fakeResponse(200, { ...found, staff: null })
        : fakeResponse(404, apiErrorBody('NOT_FOUND'));
    },
    'GET /entitlement-definitions/{id}': (request) => {
      const byId: Record<string, Schema<'EntitlementDefinition'>> = {
        [RENTAL_DEFINITION_ID]: definition(),
        [PARTY_DEFINITION_ID]: PARTY_DEFINITION,
        [MEMBERSHIP_DEFINITION_ID]: MEMBERSHIP_DEFINITION,
        [PACKAGE_DEFINITION_ID]: PACKAGE_DEFINITION,
      };
      const found = byId[request.params.id ?? ''];
      return found ? fakeResponse(200, found) : fakeResponse(404, apiErrorBody('NOT_FOUND'));
    },
    'GET /policy-versions/{id}': ok(bookingTerms()),
    'GET /resources/{id}': (request) =>
      fakeResponse(200, {
        id: request.params.id,
        name: request.params.id === RESOURCE_A ? 'Pitch 1' : 'Pitch 2',
      }),
    'GET /assets/{id}': ok({ id: ASSET_ID, name: 'Bouncy castle' }),
    // Staff coverage of a booking's events (workforce reads); nothing declared unless a test says.
    'GET /assignment-requirements': ok([]),
    'GET /assignments': page([]),
  };
}

export function membershipOffering(
  overrides: Partial<Schema<'OfferingListItem'>> = {},
): Schema<'OfferingListItem'> {
  return offering({
    id: MEMBERSHIP_OFFERING_ID,
    kind: 'membership',
    name: 'Adult membership',
    entitlementDefinitionId: MEMBERSHIP_DEFINITION_ID,
    bookingTermsPolicyVersionId: null,
    price: { priceRuleId: TERMS_ID, basePriceMinor: 12000, currency: 'USD', chargeLines: [] },
    ...overrides,
  });
}

export function packageOffering(
  overrides: Partial<Schema<'OfferingListItem'>> = {},
): Schema<'OfferingListItem'> {
  return offering({
    id: PACKAGE_OFFERING_ID,
    kind: 'package',
    name: 'Ten-session pass',
    entitlementDefinitionId: PACKAGE_DEFINITION_ID,
    bookingTermsPolicyVersionId: null,
    ...overrides,
  });
}

export function enrollment(overrides: Partial<Schema<'Enrollment'>> = {}): Schema<'Enrollment'> {
  return {
    id: MEMBERSHIP_ENROLLMENT_ID,
    offeringId: MEMBERSHIP_OFFERING_ID,
    participantPersonId: MEMBER_ID,
    intent: 'membership',
    entitlementDefinitionId: MEMBERSHIP_DEFINITION_ID,
    equivalenceKey: null,
    status: 'confirmed',
    payerPersonId: MEMBER_ID,
    registeredBy: {
      kind: 'staff',
      actorLabel: 'Front desk',
      accountId: null,
      personId: null,
      staffRoles: ['front_desk'],
    },
    assistedByPersonId: null,
    sourceApplicationId: null,
    basketId: null,
    basketLineId: null,
    placementRequestId: null,
    trialParticipationId: null,
    orderRef: null,
    lastOperationId: null,
    price: null,
    policies: {
      cancellationPolicyVersionId: null,
      eligibilityPolicyVersionId: null,
    } as Schema<'PolicyReferences'>,
    confirmedAt: '2026-09-15T17:00:00.000Z',
    canceledAt: null,
    cancellationReason: null,
    cancellationPolicyVersionId: null,
    cancellationConsequence: null,
    transferredAt: null,
    transferredToEnrollmentId: null,
    transferredFromEnrollmentId: null,
    transferConsequence: null,
    completedAt: null,
    offering: {
      id: MEMBERSHIP_OFFERING_ID,
      name: 'Adult membership',
      kind: 'membership',
      startsOn: '2026-09-01',
      endsOn: '2027-08-31',
      facilityId: FACILITY_A,
      timezone: ZONE,
    },
    pendingReason: null,
    revision: 2,
    createdAt: '2026-09-15T16:00:00.000Z',
    updatedAt: '2026-09-15T17:00:00.000Z',
    ...overrides,
  };
}

export function suspension(
  overrides: Partial<Schema<'MembershipSuspension'>> = {},
): Schema<'MembershipSuspension'> {
  return {
    id: SUSPENSION_ID,
    enrollmentId: MEMBERSHIP_ENROLLMENT_ID,
    participantPersonId: MEMBER_ID,
    from: '2026-11-10T08:00:00.000Z',
    until: null,
    reason: 'Injury',
    status: 'active',
    endedAt: null,
    endedReason: null,
    revision: 1,
    createdAt: '2026-10-24T12:00:00.000Z',
    updatedAt: '2026-10-24T12:00:00.000Z',
    ...overrides,
  };
}

export function session(
  overrides: Partial<Schema<'OfferingSession'>> = {},
): Schema<'OfferingSession'> {
  return {
    id: SESSION_ID,
    offeringId: PICKUP_OFFERING_ID,
    sequence: 1,
    title: null,
    scheduledStart: '2026-10-31T01:00:00.000Z',
    scheduledEnd: '2026-10-31T02:30:00.000Z',
    schedulingEventId: null,
    capacityOverride: null,
    status: 'scheduled',
    canceledAt: null,
    cancelReason: null,
    revision: 1,
    createdAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

export function sessionBooking(
  overrides: Partial<Schema<'SessionBooking'>> = {},
): Schema<'SessionBooking'> {
  return {
    id: SESSION_BOOKING_ID,
    offeringId: PICKUP_OFFERING_ID,
    sessionId: SESSION_ID,
    participantPersonId: MEMBER_ID,
    kind: 'pickup',
    status: 'confirmed',
    poolId: null,
    holdId: null,
    makeupEntitlementId: null,
    entitlementBasis: 'package',
    packageEntitlementId: ENTITLEMENT_ID,
    membershipEnrollmentId: null,
    creditDisposition: null,
    scheduledStart: '2026-10-17T01:00:00.000Z',
    scheduledEnd: '2026-10-17T02:30:00.000Z',
    bookedBy: {
      kind: 'staff',
      actorLabel: 'Front desk',
      accountId: null,
      personId: null,
      staffRoles: ['front_desk'],
    },
    assistedByPersonId: null,
    payerPersonId: null,
    price: null,
    policies: {
      cancellationPolicyVersionId: null,
      eligibilityPolicyVersionId: null,
    } as Schema<'PolicyReferences'>,
    eligibility: null,
    expiresAt: null,
    confirmedAt: '2026-10-10T17:00:00.000Z',
    canceledAt: null,
    cancelReason: null,
    expiredAt: null,
    revision: 1,
    createdAt: '2026-10-10T17:00:00.000Z',
    updatedAt: '2026-10-10T17:00:00.000Z',
    ...overrides,
  };
}

export function entitlement(
  overrides: Partial<Schema<'PackageEntitlement'>> = {},
): Schema<'PackageEntitlement'> {
  return {
    id: ENTITLEMENT_ID,
    participantPersonId: MEMBER_ID,
    enrollmentId: PACKAGE_ENROLLMENT_ID,
    offeringId: PACKAGE_OFFERING_ID,
    offeringName: 'Ten-session pass',
    entitlementDefinitionId: PACKAGE_DEFINITION_ID,
    appliesTo: { offeringIds: [PICKUP_OFFERING_ID], programIds: [] },
    credits: 10,
    redeemedCount: 3,
    remainingCredits: 7,
    status: 'active',
    expiresAt: '2027-03-01T08:00:00.000Z',
    issuedAt: '2026-09-02T17:00:00.000Z',
    expiredAt: null,
    revokedAt: null,
    revokedReason: null,
    redemptions: [
      {
        id: REDEMPTION_ID,
        sessionBookingId: SESSION_BOOKING_ID,
        kind: 'redeem',
        reversesRedemptionId: null,
        reason: null,
        redeemedAt: '2026-10-10T17:00:00.000Z',
      },
    ],
    revision: 4,
    createdAt: '2026-09-02T17:00:00.000Z',
    updatedAt: '2026-10-10T17:00:00.000Z',
    ...overrides,
  };
}

/** Catalog reads plus the membership and package offerings by id. */
export function entitlementRoutes(): Record<string, FakeHandler> {
  const base = catalogRoutes();
  const byId: Record<string, Schema<'OfferingListItem'>> = {
    [MEMBERSHIP_OFFERING_ID]: membershipOffering(),
    [PACKAGE_OFFERING_ID]: packageOffering(),
  };
  const offeringRead = base['GET /offerings/{id}'] as Extract<
    FakeHandler,
    (...args: never[]) => unknown
  >;
  return {
    ...base,
    'GET /offerings/{id}': (request) => {
      const found = byId[request.params.id ?? ''];
      return found ? fakeResponse(200, { ...found, staff: null }) : offeringRead(request);
    },
  };
}
