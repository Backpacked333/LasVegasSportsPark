import { newId, systemPrincipal } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DOMAIN_MODULES } from '../modules';
import {
  BOOKING_QUERY_PORT,
  EnrollmentPackageGEvents,
  type BookingQueryPort,
} from '../modules/enrollment';
import { ACCESS_DEVICE_PORT, EntryEvents, FakeAccessControlProvider } from '../modules/entry';
import {
  ASSET_DIRECTORY_PORT,
  FacilitiesEvents,
  type AssetDirectoryPort,
} from '../modules/facilities';
import { ACCOUNTING_EXPORT_PORT, FakeAccountingProvider, FinanceEvents } from '../modules/finance';
import {
  IdentityEvents,
  PERSON_DIRECTORY_PORT,
  type PersonDirectoryPort,
} from '../modules/identity';
import { CompetitionEvents } from '../modules/competition';
import { ClosureWithdrawn } from '../modules/scheduling';
import { WORKFORCE_STAFFING_PORT, type WorkforceStaffingPort } from '../modules/workforce';
import { createTestApp, type TestApp } from '../testing';

/**
 * Stage-3 interface declarations (IF-09 to IF-49): each port resolves to its declared default and
 * each declared event accepts its payload, so module builders implement and consume them on a
 * fixed contract.
 */
describe('declared module interfaces (stage 3)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp({ imports: DOMAIN_MODULES, principalResolver: 'module' });
  });
  afterAll(async () => {
    await t?.close();
  });

  it('stage-3 ports are registered by their modules and answer unknown records conservatively', async () => {
    const assets = t.app.get<AssetDirectoryPort>(ASSET_DIRECTORY_PORT);
    expect((await assets.describe(t.organizationId, [newId()])).size).toBe(0);
    const bookings = t.app.get<BookingQueryPort>(BOOKING_QUERY_PORT);
    expect(
      await bookings.bookingsOfPeriod(t.organizationId, {
        from: '2026-01-01T00:00:00Z',
        to: '2027-01-01T00:00:00Z',
      }),
    ).toEqual([]);
    const staffing = t.app.get<WorkforceStaffingPort>(WORKFORCE_STAFFING_PORT);
    // WRK-02 is registered: withdrawing the staffing of an unknown target withdraws nothing
    expect(
      await staffing.withdrawRequirements(systemPrincipal(t.organizationId, 'enrollment.booking'), {
        targetType: 'event',
        targetId: newId(),
        reason: 'probe',
      }),
    ).toEqual({ withdrawnAssignmentIds: [], retiredRequirementIds: [] });
    expect(t.app.get(ACCOUNTING_EXPORT_PORT)).toBeInstanceOf(FakeAccountingProvider);
    expect(t.app.get(ACCESS_DEVICE_PORT)).toBeInstanceOf(FakeAccessControlProvider);
    const persons = t.app.get<PersonDirectoryPort>(PERSON_DIRECTORY_PORT);
    // ID-01 is registered: an unknown person resolves to nobody
    expect(await persons.personIdsResolvingTo(t.organizationId, newId())).toEqual([]);
  });

  it('declared events accept their payloads', () => {
    const id = () => newId();
    const parses: Array<[{ payload: { parse: (v: unknown) => unknown } }, unknown]> = [
      [IdentityEvents.invitationDeclined, { invitationId: id(), declinedByPersonId: id() }],
      [IdentityEvents.invitationExpired, { invitationId: id(), via: 'sweep' }],
      [IdentityEvents.claimExpired, { claimId: id(), via: 'acceptance_attempt' }],
      [
        IdentityEvents.accessRestrictionLifted,
        { reviewId: id(), subjectPersonId: id(), grantIds: [], cause: 'window_ended' },
      ],
      [
        ClosureWithdrawn,
        {
          closureId: id(),
          facilityId: id(),
          resourceId: null,
          interval: { start: '2026-11-02T10:00:00Z', end: '2026-11-02T11:00:00Z' },
          source: 'maintenance',
          reason: 'withdrawn',
        },
      ],
      [
        FacilitiesEvents.RestrictionWithdrawn,
        {
          restrictionId: id(),
          facilityId: id(),
          resourceId: id(),
          assetId: null,
          taskId: null,
          interval: { start: '2026-11-02T10:00:00Z', end: '2026-11-02T11:00:00Z' },
          reason: 'not needed',
          schedulingClosureId: null,
        },
      ],
      [
        CompetitionEvents.availabilityRequested,
        {
          requestId: id(),
          fixtureId: id(),
          teamEntryId: id(),
          recipientPersonIds: [id()],
          scheduledStart: '2026-11-07T17:00:00Z',
          facilityId: null,
        },
      ],
      [
        EnrollmentPackageGEvents.bookingChanged,
        {
          bookingId: id(),
          kind: 'party',
          status: 'awaiting_staff',
          outstanding: ['staffing'],
          revision: 2,
        },
      ],
      [
        EnrollmentPackageGEvents.packageEntitlementChanged,
        {
          entitlementId: id(),
          participantPersonId: id(),
          change: 'redeemed',
          remainingCredits: 1,
          sessionBookingId: id(),
        },
      ],
      [
        EnrollmentPackageGEvents.membershipChanged,
        {
          enrollmentId: id(),
          participantPersonId: id(),
          change: 'renewed',
          effectiveAt: '2026-12-01T08:00:00.000Z',
        },
      ],
      [
        EnrollmentPackageGEvents.assessmentPublished,
        { assessmentId: id(), participantPersonId: id() },
      ],
      [
        EnrollmentPackageGEvents.recommendationShared,
        { recommendationId: id(), participantPersonId: id() },
      ],
      [
        FinanceEvents.accountingMappingChanged,
        { mappingId: id(), ledgerAccount: 'revenue', status: 'approved' },
      ],
      [FinanceEvents.accountingBatchChanged, { batchId: id(), status: 'unknown', lineCount: 3 }],
      [
        FinanceEvents.posSaleChanged,
        {
          saleId: id(),
          registerSessionId: id(),
          status: 'paid',
          totalMinor: 1250,
          currency: 'USD',
        },
      ],
      [
        FinanceEvents.posRegisterSessionClosed,
        {
          sessionId: id(),
          registerId: id(),
          expectedCashMinor: 10000,
          countedCashMinor: 9950,
          varianceMinor: -50,
          currency: 'USD',
        },
      ],
      [EntryEvents.accessDeviceChanged, { deviceId: id(), change: 'registered' }],
    ];
    for (const [definition, payload] of parses) {
      expect(() => definition.payload.parse(payload)).not.toThrow();
    }
    expect(() =>
      EnrollmentPackageGEvents.bookingChanged.payload.parse({
        bookingId: id(),
        kind: 'rental',
        status: 'pending',
        outstanding: [],
        revision: 1,
      }),
    ).toThrow();
  });
});
