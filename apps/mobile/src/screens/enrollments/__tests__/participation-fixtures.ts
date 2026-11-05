/**
 * Records shown next to enrollments on SCR-C-32 (applications, trial participations, session
 * bookings, memberships, checkouts), shaped like the OpenAPI components so a fixture that drifts
 * from the API fails to compile. Names are invented test values; nothing here is a facility fact.
 */
import type { Schema } from '@sportspark/api-client';
import { IDS, inDays } from '../../../features/money/testing/fixtures';
import { TEST_NOW } from '../../../testing/test-app';

const T = TEST_NOW.toISOString();

export const PIDS = {
  application: '0192f1a0-0000-7000-8000-00000000a101',
  trial: '0192f1a0-0000-7000-8000-00000000a201',
  booking: '0192f1a0-0000-7000-8000-00000000a301',
  checkout: '0192f1a0-0000-7000-8000-00000000a401',
  basket: '0192f1a0-0000-7000-8000-00000000a501',
  membershipOffering: '0192f1a0-0000-7000-8000-00000000a601',
  suspension: '0192f1a0-0000-7000-8000-00000000a701',
} as const;

const actor = {
  kind: 'customer' as const,
  accountId: null,
  personId: IDS.self,
  staffRoles: [],
  actorLabel: 'Alex',
};

export function application(overrides: Partial<Schema<'Application'>> = {}): Schema<'Application'> {
  return {
    id: PIDS.application,
    offeringId: IDS.offeringB,
    participantPersonId: IDS.child,
    intent: 'youth',
    status: 'awaiting_review',
    submittedBy: actor,
    submittedByPersonId: IDS.self,
    payerPersonId: IDS.self,
    eligibility: null,
    override: null,
    requiresApproval: true,
    teamEntryId: null,
    sessionId: null,
    notes: null,
    submittedAt: T,
    decidedAt: null,
    decidedByPersonId: null,
    decisionReason: null,
    withdrawnAt: null,
    revision: 1,
    createdAt: T,
    updatedAt: T,
    ...overrides,
  };
}

export function trial(
  overrides: Partial<Schema<'TrialParticipation'>> = {},
): Schema<'TrialParticipation'> {
  return {
    id: PIDS.trial,
    offeringId: IDS.offeringB,
    sessionId: IDS.session,
    sessionBookingId: PIDS.booking,
    participantPersonId: IDS.child,
    applicationId: null,
    status: 'scheduled',
    scheduledFor: '2026-11-03T01:00:00.000Z',
    attendedAt: null,
    noShowAt: null,
    canceledAt: null,
    followUpConsent: false,
    followUp: {},
    convertedEnrollmentId: null,
    convertedBasketId: null,
    convertedAt: null,
    registeredBy: actor,
    assistedByPersonId: null,
    revision: 1,
    createdAt: T,
    ...overrides,
  };
}

export function sessionBooking(
  overrides: Partial<NonNullable<Schema<'SessionBooking'>>> = {},
): NonNullable<Schema<'SessionBooking'>> {
  return {
    id: PIDS.booking,
    offeringId: IDS.offeringB,
    sessionId: IDS.session,
    participantPersonId: IDS.child,
    kind: 'trial',
    status: 'confirmed',
    poolId: null,
    holdId: null,
    makeupEntitlementId: null,
    entitlementBasis: 'purchase',
    packageEntitlementId: null,
    membershipEnrollmentId: null,
    creditDisposition: null,
    scheduledStart: '2026-11-03T01:00:00.000Z',
    scheduledEnd: '2026-11-03T02:00:00.000Z',
    bookedBy: actor,
    assistedByPersonId: null,
    payerPersonId: IDS.self,
    price: null,
    policies: {
      eligibilityPolicyVersionId: null,
      cancellationPolicyVersionId: null,
      requiredFormPolicyVersionIds: [],
      approvalPolicyVersionId: null,
      bookingTermsPolicyVersionId: null,
    },
    eligibility: null,
    expiresAt: null,
    confirmedAt: T,
    canceledAt: null,
    cancelReason: null,
    expiredAt: null,
    revision: 1,
    createdAt: T,
    updatedAt: T,
    ...overrides,
  };
}

/** ENR-02: the offering an enrollment carries, with its facility zone. */
export function enrollmentOffering(overrides: Partial<Schema<'EnrollmentOffering'>> = {}) {
  return {
    id: IDS.offeringClosed,
    name: 'Spring U10 League 2026',
    kind: 'season' as const,
    startsOn: '2026-03-07',
    endsOn: '2026-05-30',
    facilityId: IDS.facility,
    timezone: 'America/Los_Angeles',
    ...overrides,
  };
}

export function membership(overrides: Partial<Schema<'Membership'>> = {}): Schema<'Membership'> {
  return {
    enrollmentId: IDS.enrollment,
    participantPersonId: IDS.child,
    offeringId: PIDS.membershipOffering,
    offeringName: 'Family membership',
    status: 'confirmed',
    termStartsAt: '2026-09-01T07:00:00.000Z',
    termEndsAt: '2027-09-01T07:00:00.000Z',
    attendance: {
      mode: 'included_sessions',
      limit: { count: 4, period: 'month', weekStartsOn: null },
      appliesTo: null,
    },
    renewedFromEnrollmentId: null,
    suspensions: [
      {
        id: PIDS.suspension,
        enrollmentId: IDS.enrollment,
        participantPersonId: IDS.child,
        from: inDays(5),
        until: null,
        reason: 'Injury',
        status: 'active',
        endedAt: null,
        endedReason: null,
        revision: 1,
        createdAt: T,
        updatedAt: T,
      },
    ],
    usage: [{ periodKey: '2026-10', usedCount: 2, limitCount: 4 }],
    revision: 1,
    createdAt: T,
    ...overrides,
  };
}
