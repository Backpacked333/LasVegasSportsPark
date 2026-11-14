import { describe, expect, it } from 'vitest';
import {
  createAcknowledgmentFixture,
  createOfferingFixture,
  createProgramFixture,
} from '../../modules/catalog';
import { seedPitchWithHalves } from '../../modules/scheduling';
import { adult, enableCapability, get, journeyApp, ok, post, staff } from './support';

/**
 * Phase 0 verification of field rentals against the way the facility's current system is used
 * (docs/package-a/legacy-parity-verification.md): staff enter the rental for the renter, and a
 * field is rented whole or by half. It records what the assembled application does today.
 * Prices, names and times are test data.
 */

const HOUR = 3_600_000;

describe('Facility rental scenarios (assembled application)', () => {
  it('SPK-COND-003, SPK-SCHED-002: staff book a whole field for a renter; a half of that field cannot be booked over it', async () => {
    const t = await journeyApp({ clockStart: '2026-11-09T16:00:00Z' });
    try {
      const admin = await staff(t, ['system_administrator']);
      const pm = await staff(t, ['program_manager']);
      const finance = await staff(t, ['finance_operator']);
      const desk = await staff(t, ['front_desk']);
      const scheduler = await staff(t, ['scheduler']);
      await enableCapability(t, admin, 'rentals', 'DEC-076');
      const pitch = await seedPitchWithHalves(t.db, {
        organizationId: t.organizationId,
        facilityId: t.facilityId,
        name: 'Field 1',
      });
      const programId = await createProgramFixture(t, { ageBand: { minAgeYears: 18 } });
      const definition = await ok<{ id: string }>(
        post(t, '/v1/entitlement-definitions', pm.header, {
          name: 'Field 1 rental',
          kind: 'rental_resource',
          scope: {
            resources: {
              resourceIds: [pitch.pitchId, pitch.northHalfId, pitch.southHalfId],
              count: 1,
            },
            staffing: [],
          },
          equivalenceScope: 'none',
        }),
        201,
      );
      const terms = await ok<{ id: string }>(
        post(t, '/v1/policy-versions', pm.header, {
          kind: 'booking_terms',
          key: 'field-rental-terms',
          title: 'Field rental terms',
          content: {
            confirmationMode: 'instant',
            installmentPolicyKey: null,
            accessConditions: 'Check in at the front desk',
            hostResponsibilities: null,
          },
          effectiveFrom: '2026-10-01T00:00:00Z',
        }),
        201,
      );
      await ok(post(t, `/v1/policy-versions/${terms.id}/approve`, finance.header, {}));
      const rental = await createOfferingFixture(t, {
        responsibleManagerPersonId: pm.personId,
        programId,
        kind: 'rental',
        publicationState: 'draft',
        entitlementDefinitionId: definition.id,
        bookingTermsKey: 'field-rental-terms',
        basePriceMinor: 12_000,
      });
      await ok(post(t, `/v1/offerings/${rental.offeringId}/publish`, pm.header, {}));
      await ok(post(t, `/v1/offerings/${rental.offeringId}/registration/open`, pm.header, {}));

      const renter = await adult(t);
      const other = await adult(t);
      for (const person of [renter, other]) {
        await createAcknowledgmentFixture(t, {
          subjectPersonId: person.personId,
          policyVersionId: rental.formPolicyVersionId,
          signedByPersonId: person.personId,
        });
      }
      const start = Date.parse('2026-11-14T02:00:00Z');
      const book = (who: { Authorization: string }, body: Record<string, unknown>) =>
        post(t, '/v1/bookings', who, {
          offeringId: rental.offeringId,
          start: new Date(start).toISOString(),
          end: new Date(start + HOUR).toISOString(),
          ...body,
        });

      // The desk enters the rental for the renter: the field is held and payment is what remains.
      const entered = await ok<{ id: string; occurrences: Array<{ eventId: string | null }> }>(
        book(desk.header, { bookerPersonId: renter.personId, resourceIds: [pitch.pitchId] }),
        201,
      );
      expect(entered).toMatchObject({
        kind: 'rental',
        bookerPersonId: renter.personId,
        status: 'held',
        outstanding: ['payment'],
      });
      expect(entered.occurrences.every((o) => o.eventId !== null)).toBe(true);

      // Half of a field that is rented whole is refused, with the reservation in the way named.
      const half = await book(other.header, { resourceIds: [pitch.northHalfId] });
      expect(half.status).toBe(409);
      expect(half.body.code).toBe('RESOURCE_CONFLICT');
      expect(half.body.details.conflicts).toEqual([
        expect.objectContaining({ code: 'physical_overlap' }),
      ]);
      // §4.10: another customer cannot read the renter's booking.
      expect((await get(t, `/v1/bookings/${entered.id}`, other.header)).status).toBe(404);
      expect((await get(t, `/v1/bookings/${entered.id}`, renter.header)).status).toBe(200);
      // The scheduler enters a rental on another day the same way.
      const later = await book(scheduler.header, {
        bookerPersonId: renter.personId,
        resourceIds: [pitch.southHalfId],
        start: new Date(start + 24 * HOUR).toISOString(),
        end: new Date(start + 25 * HOUR).toISOString(),
      });
      expect(later.status).toBe(201);
    } finally {
      await t.close();
    }
  });
});
