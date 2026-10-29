import type { StagedRow } from '@sportspark/contracts';
import { describe, expect, it } from 'vitest';
import type { TestApp } from '../../testing';
import {
  createAcknowledgmentFixture,
  createOfferingFixture,
  createProgramFixture,
} from '../../modules/catalog';
import { controlTotalsFor, stagedEvent } from '../../modules/migration';
import { at, createScheduledEvent, EventsService, seedResource } from '../../modules/scheduling';
import { adult, enableCapability, get, journeyApp, ok, post, staff, type Actor } from './support';

/**
 * §5.6, §4.7 invariant 11 (K-11, MIG-00, IF-42): while the legacy system is the authoritative
 * writer of a record category, SportsPark refuses to become a second writer of it, whether the
 * write arrives by HTTP or in-process, and accepts the legacy data only through an import batch,
 * which creates drafts. Across migration (authority matrix, imports), enrollment (rental
 * bookings), scheduling (reservations, imported events) and finance (point-of-sale orders). That
 * every served write route is classified exactly once is proven on the same assembled application
 * by the migration module's route classification test.
 */
describe('Record authority (assembled application)', () => {
  it('future_schedule legacy at the facility refuses a rental booking and an in-process reservation, the import still creates draft events, and the cutover lets bookings through; order legacy refuses POS sales', async () => {
    const t: TestApp = await journeyApp({ clockStart: '2026-11-09T16:00:00Z' });
    try {
      const admin = await staff(t, ['system_administrator']);
      const operator = await staff(t, ['general_manager']);
      const pm = await staff(t, ['program_manager']);
      const finance = await staff(t, ['finance_operator']);
      const desk = await staff(t, ['front_desk']);
      await enableCapability(t, admin, 'rentals', 'DEC-076');
      await enableCapability(t, admin, 'point_of_sale', 'DEC-079');
      const field = (
        await seedResource(t.db, {
          organizationId: t.organizationId,
          facilityId: t.facilityId,
          name: 'Field A',
        })
      ).resourceId;

      // A published instant rental of Field A under approved booking terms.
      const definition = await ok<{ id: string }>(
        post(t, '/v1/entitlement-definitions', pm.header, {
          name: 'Field A rental',
          kind: 'rental_resource',
          scope: { resources: { resourceIds: [field], count: 1 }, staffing: [] },
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
            accessConditions: 'Gate code at the front desk',
            hostResponsibilities: null,
          },
          effectiveFrom: '2026-10-01T00:00:00Z',
        }),
        201,
      );
      await ok(post(t, `/v1/policy-versions/${terms.id}/approve`, finance.header, {}));
      const offering = await createOfferingFixture(t, {
        responsibleManagerPersonId: pm.personId,
        programId: await createProgramFixture(t, { ageBand: { minAgeYears: 18 } }),
        kind: 'rental',
        publicationState: 'draft',
        entitlementDefinitionId: definition.id,
        bookingTermsKey: 'field-rental-terms',
        basePriceMinor: 5_000,
      });
      await ok(post(t, `/v1/offerings/${offering.offeringId}/publish`, pm.header, {}));
      await ok(post(t, `/v1/offerings/${offering.offeringId}/registration/open`, pm.header, {}));
      const customer = await adult(t);
      await createAcknowledgmentFixture(t, {
        subjectPersonId: customer.personId,
        policyVersionId: offering.formPolicyVersionId,
        signedByPersonId: customer.personId,
      });
      const book = (start: string) =>
        post(t, '/v1/bookings', customer.header, {
          offeringId: offering.offeringId,
          start,
          end: new Date(Date.parse(start) + 3_600_000).toISOString(),
          resourceIds: [field],
        });
      const footprint = async () => ({
        bookings: (await t.db.selectFrom('bookings').select('id').execute()).length,
        events: (await t.db.selectFrom('events').select('id').execute()).length,
        reservations: (await t.db.selectFrom('reservations').select('id').execute()).length,
      });

      // Without any assignment SportsPark is authoritative: the booking holds the field.
      expect((await ok<{ status: string }>(book('2026-11-12T02:00:00Z'), 201)).status).toBe('held');

      // §6.6: only the operator names the legacy booking tool authoritative for the facility.
      const assign = (actor: Actor, body: Record<string, unknown>) =>
        post(t, '/v1/authority-assignments', actor.header, {
          authoritativeSystem: 'legacy',
          reason: 'The legacy booking tool keeps the facility schedule until cutover',
          ...body,
        });
      const facilitySchedule = {
        recordCategory: 'future_schedule',
        scope: { kind: 'facility', facilityId: t.facilityId },
      };
      expect((await assign(admin, facilitySchedule)).status).toBe(403);
      expect((await assign(desk, facilitySchedule)).status).toBe(403);
      const schedule = await ok<{ id: string; revision: number }>(
        assign(operator, facilitySchedule),
        201,
      );
      const matrix = await get(t, '/v1/authority-matrix', desk.header);
      expect(matrix.status).toBe(200);

      // A customer booking would reserve the facility schedule: refused, nothing written.
      const before = await footprint();
      const refused = await book('2026-11-13T02:00:00Z');
      expect(refused.status).toBe(403);
      expect(refused.body).toMatchObject({
        code: 'ACCESS_DENIED',
        nextAction: 'write_in_authoritative_system',
        details: { code: 'LEGACY_AUTHORITY', recordCategory: 'future_schedule' },
      });
      expect(await footprint()).toEqual(before);
      // An in-process reservation through the scheduling port is refused the same way (IF-42).
      await expect(
        createScheduledEvent(t.app.get(EventsService, { strict: false }), {
          organizationId: t.organizationId,
          facilityId: t.facilityId,
          resourceIds: [field],
          start: at('2026-11-14', '10:00'),
          end: at('2026-11-14', '11:00'),
          title: 'Rental',
        }),
      ).rejects.toMatchObject({
        code: 'ACCESS_DENIED',
        details: { code: 'LEGACY_AUTHORITY', recordCategory: 'future_schedule' },
      });
      expect(await footprint()).toEqual(before);

      // The legacy schedule arrives through an import batch: its events are drafts holding no
      // space, and nothing is published.
      const rows: StagedRow[] = [
        stagedEvent('LEG-EV-1', {
          facilityId: t.facilityId,
          resourceIds: [field],
          scheduledStart: at('2026-11-21', '10:00'),
          scheduledEnd: at('2026-11-21', '11:00'),
          title: 'Legacy league game',
        }),
      ];
      const staged = await ok<{ id: string }>(
        post(t, '/v1/import-batches', operator.header, {
          sourceSystem: 'legacy-booking-tool',
          snapshotTakenAt: '2026-11-09T08:00:00.000Z',
          transformationVersion: 'staging-v1',
          extraction: { tool: 'export-script', extractedBy: 'migration owner' },
          controlTotals: controlTotalsFor(rows),
          rows,
        }),
        201,
      );
      const validated = await ok<{ revision: number; exceptions: { open: number } }>(
        post(t, `/v1/import-batches/${staged.id}/validate`, operator.header, {}),
      );
      expect(validated.exceptions.open).toBe(0);
      await ok(
        post(t, `/v1/import-batches/${staged.id}/review`, operator.header, {
          expectedRevision: validated.revision,
        }),
      );
      const applied = await ok<{ status: string }>(
        post(t, `/v1/import-batches/${staged.id}/apply`, operator.header, {}),
      );
      expect(applied.status).toBe('applied');
      const imported = await t.db
        .selectFrom('events')
        .select(['id', 'status', 'source_type'])
        .where('title', '=', 'Legacy league game')
        .executeTakeFirstOrThrow();
      expect(imported).toMatchObject({ status: 'draft', source_type: 'import' });
      expect(
        await t.db
          .selectFrom('reservations')
          .select('id')
          .where('event_id', '=', imported.id)
          .execute(),
      ).toEqual([]);

      // Cutover: the operator ends the legacy assignment (never retroactively); bookings resume.
      t.clock.advance(60_000);
      await ok(
        post(t, `/v1/authority-assignments/${schedule.id}/end`, operator.header, {
          reason: 'Cutover to SportsPark scheduling',
          expectedRevision: schedule.revision,
        }),
      );
      expect((await ok<{ status: string }>(book('2026-11-13T02:00:00Z'), 201)).status).toBe('held');

      // Orders: while the legacy till writes orders, a point-of-sale sale is refused.
      const register = await ok<{ id: string }>(
        post(t, '/v1/pos-registers', operator.header, {
          facilityId: t.facilityId,
          code: 'FD1',
          name: 'Front desk',
        }),
        201,
      );
      const session = await ok<{ id: string }>(
        post(t, `/v1/pos-registers/${register.id}/sessions`, desk.header, {
          currency: 'USD',
          openingFloatMinor: 0,
        }),
        201,
      );
      await ok(assign(operator, { recordCategory: 'order' }), 201);
      const sale = await post(t, '/v1/pos-sales', desk.header, { registerSessionId: session.id });
      expect(sale.status).toBe(403);
      expect(sale.body.details).toMatchObject({
        code: 'LEGACY_AUTHORITY',
        recordCategory: 'order',
      });
      expect(await t.db.selectFrom('pos_sales').select('id').execute()).toEqual([]);
    } finally {
      await t.close();
    }
  });
});
