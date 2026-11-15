import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '@sportspark/contracts';
import { createTestApp, type TestApp } from '../../../testing';
import { authHeaderForPerson, createStaffMemberFixture } from '../../identity';
import { EventsService } from '../../scheduling';
import {
  at,
  createScheduledEvent,
  seedResource,
} from '../../scheduling/testing/scheduling-fixtures';
import { CatalogModule } from '../catalog.module';
import { createOfferingFixture, createOfferingSessionFixture } from '../testing/catalog-fixtures';

const DAY = '2026-11-21';

/**
 * SPK-SCHED-010 (proposed amendment PA-06, ADR-005): what the public schedule calls a class. Only
 * catalog can say that a session belongs to an offering anyone may already read about, so only
 * then is the offering's name shown; the title a person typed on the event never is.
 */
describe('public schedule titles of catalog sessions (SPK-SCHED-010)', () => {
  let t: TestApp;
  let code: string;
  const slug = 'desert-park';
  const typed = "Tots with Coach Anna (Tommy's group)";

  beforeAll(async () => {
    t = await createTestApp({
      imports: [CatalogModule],
      clockStart: '2026-11-21T18:00:00Z',
      capabilities: ['public_schedule'],
    });
    const events = t.app.get(EventsService);
    await t.db
      .updateTable('organizations')
      .set({ slug, name: 'Desert Park' })
      .where('id', '=', t.organizationId)
      .execute();
    const ctx = {
      db: t.db,
      clock: t.clock,
      organizationId: t.organizationId,
      facilityId: t.facilityId,
    };
    const base = { organizationId: t.organizationId, facilityId: t.facilityId };
    const manager = await createStaffMemberFixture(t, { roles: ['program_manager'] });
    const pm = await authHeaderForPerson(t, manager.personId);
    const scheduler = await createStaffMemberFixture(t, { roles: ['scheduler'] });
    const session = async (
      field: string,
      start: string,
      offering: { name: string; publicationState: 'published' | 'draft' },
      status: 'scheduled' | 'canceled' = 'scheduled',
    ) => {
      const { resourceId } = await seedResource(t.db, { ...base, name: field });
      const event = await createScheduledEvent(events, {
        ...base,
        resourceIds: [resourceId],
        start: at(DAY, start),
        end: at(DAY, '23:00'),
        kind: 'session',
        title: typed,
        sourceType: 'session',
      });
      const created = await createOfferingFixture(ctx, {
        name: offering.name,
        responsibleManagerPersonId: manager.personId,
        publicationState: 'draft',
      });
      if (offering.publicationState === 'published') {
        const published = await t.http
          .post(`/v1/offerings/${created.offeringId}/publish`)
          .set(pm)
          .set('Idempotency-Key', `k-${newId()}`)
          .send({});
        expect(published.status, JSON.stringify(published.body)).toBe(200);
      }
      await createOfferingSessionFixture(ctx, {
        offeringId: created.offeringId,
        scheduledStart: new Date(at(DAY, start)),
        scheduledEnd: new Date(at(DAY, '23:00')),
        schedulingEventId: event.id,
        status,
      });
    };
    await session('Field 1', '09:00', { name: 'Saturday skills', publicationState: 'published' });
    await session('Field 2', '10:00', { name: 'Coaches only clinic', publicationState: 'draft' });
    await session(
      'Field 3',
      '11:00',
      { name: 'Called off camp day', publicationState: 'published' },
      'canceled',
    );
    const enabled = await t.http
      .post(`/v1/facilities/${t.facilityId}/public-schedule-view/enable`)
      .set(await authHeaderForPerson(t, scheduler.personId))
      .set('Idempotency-Key', `k-${newId()}`)
      .send({});
    expect(enabled.status, JSON.stringify(enabled.body)).toBe(200);
    code = enabled.body.publicCode as string;
  });
  afterAll(async () => {
    await t.close();
  });

  it('SPK-SCHED-010: a session of a published offering shows the offering name; a session of an offering that is not public, or a session catalog has canceled, shows only "Class"; the typed title is never shown', async () => {
    const res = await t.http.get(`/v1/public/${slug}/schedule/${code}?date=${DAY}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const text = JSON.stringify(res.body);
    expect(text).toContain('Saturday skills');
    expect(text).not.toContain('Coaches only clinic');
    expect(text).not.toContain('Called off camp day');
    expect(text).not.toContain('Tommy');
    expect(text).not.toContain('Coach Anna');
    // Three sessions on the day: one named by catalog, two shown by their kind.
    expect(text.match(/"Class"/g)?.length).toBe(2);
  });
});
