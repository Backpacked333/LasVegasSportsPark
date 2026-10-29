import {
  DomainError,
  importActorLabel,
  newId,
  systemPrincipal,
  type Principal,
} from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UnitOfWork } from '../../../kernel';
import { createTestApp, staffPrincipal, type TestApp } from '../../../testing';
import { EVENT_SCHEDULING_PORT, type EventSchedulingPort, type ImportEventInput } from '../ports';
import { SchedulingModule } from '../scheduling.module';
import { ClosuresService } from '../services/closures.service';
import { IMPORT_SOURCE_TYPE } from '../services/event-import.service';
import { EventsService } from '../services/events.service';
import { ScheduleDraftsService } from '../services/schedule-drafts.service';
import {
  at,
  createAppliedClosure,
  createScheduledEvent,
  seedPitchWithHalves,
  teamCommitment,
  type PitchFixture,
} from '../testing/scheduling-fixtures';

async function caught(promise: Promise<unknown>): Promise<DomainError> {
  try {
    await promise;
  } catch (error) {
    if (DomainError.is(error)) return error;
    throw error;
  }
  throw new Error('expected the call to fail');
}

/**
 * SCH-04 (§5.3 future schedules, §5.4, SPK-AT-024, IF-31, IF-40): EventSchedulingPort.importEvent
 * writes a create-if-absent draft for the migration import principal, checks the current schedule
 * at import time, and publishes nothing; the draft is published through a schedule draft.
 */
describe('event import (SCH-04: §5.3, §5.4, SPK-AT-024)', () => {
  let t: TestApp;
  let port: EventSchedulingPort;
  let events: EventsService;
  let uow: UnitOfWork;
  let org: string;
  let facility: string;
  let pitch: PitchFixture;
  const batchId = newId();
  let importer: Principal;

  beforeAll(async () => {
    t = await createTestApp({ imports: [SchedulingModule], clockStart: '2026-10-19T12:00:00Z' });
    port = t.app.get<EventSchedulingPort>(EVENT_SCHEDULING_PORT);
    events = t.app.get(EventsService);
    uow = t.app.get(UnitOfWork);
    org = t.organizationId;
    facility = t.facilityId;
    pitch = await seedPitchWithHalves(t.db, {
      organizationId: org,
      facilityId: facility,
      name: 'Pitch 1',
    });
    importer = systemPrincipal(org, importActorLabel(batchId));
  });
  afterAll(async () => {
    await t.close();
  });

  const legacyFixture = (overrides: Partial<ImportEventInput> = {}): ImportEventInput => ({
    facilityId: facility,
    kind: 'game',
    title: 'Legacy U12 fixture',
    scheduledStart: at('2026-11-21', '10:00'),
    scheduledEnd: at('2026-11-21', '11:00'),
    resourceIds: [pitch.northHalfId],
    commitments: [teamCommitment(newId())],
    sourceType: 'fixture',
    sourceId: newId(),
    importProvenance: { batchId, externalKey: `legacy-${newId()}`, recordId: newId() },
    ...overrides,
  });

  const importRun = (input: ImportEventInput, principal: Principal = importer) =>
    uow.run(() => port.importEvent(principal, input));

  it('SPK-AT-024: importing the same event twice creates one draft event', async () => {
    const input = legacyFixture();
    const first = await importRun(input);
    expect(first).toMatchObject({
      id: input.importProvenance.recordId,
      status: 'draft',
      sourceType: IMPORT_SOURCE_TYPE,
      sourceId: batchId,
      publishedRevision: null,
      resourceIds: [pitch.northHalfId],
    });
    const again = await importRun(input);
    expect(again).toEqual(first);
    const rows = await t.db
      .selectFrom('events')
      .select(['id', 'status', 'source_type', 'source_id'])
      .where('id', '=', input.importProvenance.recordId)
      .execute();
    expect(rows).toEqual([
      {
        id: input.importProvenance.recordId,
        status: 'draft',
        source_type: 'import',
        source_id: batchId,
      },
    ]);
    // one audit record, by the import actor
    const audit = await t.db
      .selectFrom('audit_records')
      .select(['action', 'actor', 'details'])
      .where('target_id', '=', input.importProvenance.recordId)
      .execute();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: 'scheduling.event_imported',
      actor: expect.objectContaining({ kind: 'system', actorLabel: importActorLabel(batchId) }),
      details: { batchId, externalKey: input.importProvenance.externalKey, status: 'draft' },
    });
    // the same record with different content is a mismatch, never a second version
    const changed = await caught(importRun({ ...input, title: 'Renamed fixture' }));
    expect(changed).toMatchObject({
      code: 'RESOURCE_CONFLICT',
      details: { code: 'IMPORT_CONTENT_MISMATCH', recordId: input.importProvenance.recordId },
    });
    const moved = await caught(importRun({ ...input, scheduledEnd: at('2026-11-21', '11:30') }));
    expect(moved.details).toMatchObject({ code: 'IMPORT_CONTENT_MISMATCH' });
  });

  it('only the import principal of the batch imports (IF-40)', async () => {
    const input = legacyFixture();
    for (const principal of [
      staffPrincipal(org, ['system_administrator']),
      systemPrincipal(org, importActorLabel(newId())),
      systemPrincipal(org, 'enrollment.booking'),
    ]) {
      const error = await caught(importRun(input, principal));
      expect(error).toMatchObject({
        code: 'ACCESS_DENIED',
        details: { code: 'IMPORT_PRINCIPAL_REQUIRED' },
      });
    }
    expect(
      await t.db
        .selectFrom('events')
        .select('id')
        .where('id', '=', input.importProvenance.recordId)
        .execute(),
    ).toEqual([]);
  });

  it('an import that conflicts with an existing reservation or closure answers IMPORT_SCHEDULE_CONFLICT and writes nothing', async () => {
    const booked = await createScheduledEvent(events, {
      organizationId: org,
      facilityId: facility,
      resourceIds: [pitch.pitchId],
      start: at('2026-11-22', '10:00'),
      end: at('2026-11-22', '11:00'),
      title: 'Current booking',
    });
    const overReservation = legacyFixture({
      scheduledStart: at('2026-11-22', '10:30'),
      scheduledEnd: at('2026-11-22', '11:30'),
    });
    const reservationConflict = await caught(importRun(overReservation));
    expect(reservationConflict).toMatchObject({
      code: 'RESOURCE_CONFLICT',
      details: {
        code: 'IMPORT_SCHEDULE_CONFLICT',
        recordId: overReservation.importProvenance.recordId,
        externalKey: overReservation.importProvenance.externalKey,
        conflictingEventIds: [booked.id],
      },
    });
    expect(
      (reservationConflict.details as { conflicts: Array<{ code: string }> }).conflicts.map(
        (c) => c.code,
      ),
    ).toContain('physical_overlap');

    await createAppliedClosure(t.app.get(ClosuresService), {
      organizationId: org,
      facilityId: facility,
      resourceId: pitch.southHalfId,
      start: at('2026-11-23', '08:00'),
      end: at('2026-11-23', '20:00'),
      reason: 'Reseeding',
    });
    const overClosure = legacyFixture({
      resourceIds: [pitch.southHalfId],
      scheduledStart: at('2026-11-23', '12:00'),
      scheduledEnd: at('2026-11-23', '13:00'),
    });
    const closureConflict = await caught(importRun(overClosure));
    expect(closureConflict.details).toMatchObject({ code: 'IMPORT_SCHEDULE_CONFLICT' });
    expect(
      (closureConflict.details as { conflicts: Array<{ code: string }> }).conflicts.map(
        (c) => c.code,
      ),
    ).toEqual(['closure']);

    for (const input of [overReservation, overClosure]) {
      expect(
        await t.db
          .selectFrom('events')
          .select('id')
          .where('id', '=', input.importProvenance.recordId)
          .execute(),
      ).toEqual([]);
      expect(
        await t.db
          .selectFrom('audit_records')
          .select('id')
          .where('target_id', '=', input.importProvenance.recordId)
          .execute(),
      ).toEqual([]);
    }
  });

  it('§5.6: importing publishes nothing; a schedule draft publishes the imported draft', async () => {
    const input = legacyFixture({
      scheduledStart: at('2026-11-28', '09:00'),
      scheduledEnd: at('2026-11-28', '10:00'),
    });
    const imported = await importRun(input);
    const holds = async () => ({
      reservations: await t.db
        .selectFrom('reservations')
        .select('id')
        .where('event_id', '=', imported.id)
        .execute(),
      commitments: await t.db
        .selectFrom('event_commitments')
        .select('id')
        .where('event_id', '=', imported.id)
        .execute(),
      notices: await t.db
        .selectFrom('outbox_events')
        .select('event_type')
        .where('aggregate_id', '=', imported.id)
        .execute(),
    });
    expect(await holds()).toEqual({ reservations: [], commitments: [], notices: [] });
    // the space stays bookable: a draft holds nothing
    const competing = await createScheduledEvent(events, {
      organizationId: org,
      facilityId: facility,
      resourceIds: [pitch.southHalfId],
      start: at('2026-11-28', '09:00'),
      end: at('2026-11-28', '10:00'),
    });
    expect(competing.status).toBe('published');

    // publication goes through a schedule draft whose create change names the imported event
    const drafts = t.app.get(ScheduleDraftsService);
    const scheduler = staffPrincipal(org, ['scheduler']);
    const draft = await drafts.create(scheduler, {
      facilityId: facility,
      name: 'Publish imported fixtures',
      changes: [{ kind: 'create', targetEventId: imported.id }],
    });
    const publication = await drafts.publish(scheduler, draft.id, {});
    expect(publication.eventIds).toEqual([imported.id]);
    const published = await events.getEvent(scheduler, imported.id);
    expect(published.status).toBe('published');
    const after = await holds();
    expect(after.reservations).toHaveLength(1);
    expect(after.notices.map((n) => n.event_type)).toEqual(['scheduling.event_changed']);
    // re-running the batch after publication changes nothing
    expect((await importRun(input)).status).toBe('published');
  });

  it('K-13: a resource turnover change between runs does not turn an unchanged record into a mismatch', async () => {
    const resource = await t.db
      .selectFrom('resources')
      .select(['default_setup_minutes', 'default_cleanup_minutes'])
      .where('id', '=', pitch.southHalfId)
      .executeTakeFirstOrThrow();
    const input = legacyFixture({
      resourceIds: [pitch.southHalfId],
      scheduledStart: at('2027-02-20', '06:00'),
      scheduledEnd: at('2027-02-20', '07:00'),
    });
    const first = await importRun(input);
    await t.db
      .updateTable('resources')
      .set({
        default_setup_minutes: resource.default_setup_minutes + 15,
        default_cleanup_minutes: resource.default_cleanup_minutes + 15,
      })
      .where('id', '=', pitch.southHalfId)
      .execute();
    try {
      const again = await importRun(input);
      expect(again).toEqual(first);
      const audit = await t.db
        .selectFrom('audit_records')
        .select('id')
        .where('target_id', '=', input.importProvenance.recordId)
        .execute();
      expect(audit).toHaveLength(1);
      // a record whose legacy content did change is still a mismatch
      const changed = await caught(importRun({ ...input, title: 'Renamed in the legacy system' }));
      expect(changed.details).toMatchObject({ code: 'IMPORT_CONTENT_MISMATCH' });
    } finally {
      await t.db
        .updateTable('resources')
        .set({
          default_setup_minutes: resource.default_setup_minutes,
          default_cleanup_minutes: resource.default_cleanup_minutes,
        })
        .where('id', '=', pitch.southHalfId)
        .execute();
    }
  });
});
