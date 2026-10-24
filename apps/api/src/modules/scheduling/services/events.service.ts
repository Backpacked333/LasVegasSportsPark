import { Inject, Injectable } from '@nestjs/common';
import {
  decodeCursor,
  encodeCursor,
  errors,
  z,
  type Event,
  type Interval,
  type ListEventsQuery,
  type Page,
  type Principal,
  type Reservation,
} from '@sportspark/contracts';
import { tstzrange, type Db } from '@sportspark/db';
import { sql } from 'kysely';
import {
  assertExpectedRevision,
  AuditWriter,
  AuthorizationService,
  UnitOfWork,
  executorFor,
} from '../../../kernel';
import { DATABASE } from '../../../kernel/tokens';
import type {
  AvailabilityPort,
  CancelEventInput,
  CreateEventInput,
  EventSchedulingPort,
  FindAvailableSlotsInput,
  MoveEventInput,
  ReservationQuery,
  ReservationQueryPort,
} from '../ports';
import { SchedulingActions } from '../scheduling.actions';
import { EventMachine } from '../scheduling.state-machines';
import { localMinuteSpan, minutesOf } from '../time/local-time';
import { EventWriter, sameResourceSet } from './event-writer';

const Cursor = z.object({ start: z.string(), id: z.string() });

export function organizationOf(principal: Principal): string {
  if (!principal.organizationId) throw errors.authenticationRequired();
  return principal.organizationId;
}

/**
 * Direct scheduling for owning records (fixtures, sessions, rentals …) and read access to the
 * schedule. Every write is one transaction: authorization against the facility, conflict
 * detection naming the colliding events (SPK-SCHED-002/003/004), the exclusion constraints as the
 * final guarantee, audit, and the change notice with old and new practical details.
 */
@Injectable()
export class EventsService implements EventSchedulingPort, AvailabilityPort, ReservationQueryPort {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly writer: EventWriter,
  ) {}

  async createEvent(principal: Principal, input: CreateEventInput): Promise<Event> {
    const organizationId = organizationOf(principal);
    const scheduledStart = new Date(input.scheduledStart);
    const scheduledEnd = new Date(input.scheduledEnd);
    if (!(scheduledStart < scheduledEnd)) {
      throw errors.validation('scheduledStart must be before scheduledEnd.');
    }
    return this.uow.run(async ({ trx }) => {
      const facility = await this.writer.loadFacility(trx, organizationId, input.facilityId);
      await this.authorization.require(principal, SchedulingActions.manageEvents, {
        type: 'event',
        organizationId,
        facilityId: facility.id,
      });
      const resources = await this.writer.loadResources(
        trx,
        organizationId,
        facility.id,
        input.resourceIds,
      );
      // SPK-SCHED-003: the reserved resources' turnover requirement is the minimum buffer
      const buffers = this.writer.effectiveBuffers(resources, input);
      const status = input.status ?? 'published';
      const data = {
        organizationId,
        facilityId: facility.id,
        timezone: facility.timezone,
        kind: input.kind,
        title: input.title,
        format: input.format ?? null,
        scheduledStart,
        scheduledEnd,
        setupMinutes: buffers.setupMinutes,
        cleanupMinutes: buffers.cleanupMinutes,
        status,
        resourceIds: resources.map((r) => r.id),
        commitments: input.commitments ?? [],
        sourceType: input.sourceType,
        sourceId: input.sourceId,
      };
      if (status === 'published') {
        await this.writer.detectOrThrow(trx, organizationId, facility, [
          {
            key: 'new',
            eventId: null,
            kind: data.kind,
            format: data.format,
            scheduledStart,
            scheduledEnd,
            setupMinutes: data.setupMinutes,
            cleanupMinutes: data.cleanupMinutes,
            resourceIds: data.resourceIds,
            commitments: data.commitments,
          },
        ]);
      }
      const event = await this.writer.insertEvent(trx, data);
      if (status === 'published') await this.writer.reserve(trx, event, facility);
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: 'scheduling.event_created',
        targetType: 'event',
        targetId: event.id,
        afterRevision: event.revision,
        reason: input.reason ?? null,
        correlationId: input.correlationId ?? null,
        details: { status, sourceType: input.sourceType, sourceId: input.sourceId },
      });
      if (status === 'published') {
        await this.writer.notifyChanged(trx, {
          organizationId,
          event,
          change: 'created',
          before: null,
          after: await this.writer.details(trx, event),
          reason: input.reason ?? null,
          correlationId: input.correlationId ?? null,
        });
      }
      return this.writer.view(event);
    });
  }

  async moveEvent(principal: Principal, eventId: string, input: MoveEventInput): Promise<Event> {
    const organizationId = organizationOf(principal);
    const scheduledStart = new Date(input.scheduledStart);
    const scheduledEnd = new Date(input.scheduledEnd);
    if (!(scheduledStart < scheduledEnd)) {
      throw errors.validation('scheduledStart must be before scheduledEnd.');
    }
    return this.uow.run(async ({ trx }) => {
      const event = await this.writer.loadEvent(trx, organizationId, eventId, { forUpdate: true });
      if (!event) throw errors.protectedNotFound('event');
      const facility = await this.writer.loadFacility(trx, organizationId, event.facility_id);
      await this.authorization.require(principal, SchedulingActions.manageEvents, {
        type: 'event',
        id: event.id,
        organizationId,
        facilityId: facility.id,
      });
      assertExpectedRevision(input.expectedRevision, event.revision);
      if (event.status === 'canceled') throw errors.invalidTransition('Event', 'canceled', 'move');
      const resources = await this.writer.loadResources(
        trx,
        organizationId,
        facility.id,
        input.resourceIds ?? event.resource_ids,
      );
      const before = await this.writer.details(trx, event);
      // SPK-SCHED-003: buffers follow the resources actually reserved; the event's own buffers
      // carry over only while it stays on the same resources, never below their requirement.
      const resourceIds = resources.map((r) => r.id);
      const sameResources = sameResourceSet(resourceIds, event.resource_ids);
      const buffers = this.writer.effectiveBuffers(resources, {
        setupMinutes: input.setupMinutes ?? (sameResources ? event.setup_minutes : undefined),
        cleanupMinutes: input.cleanupMinutes ?? (sameResources ? event.cleanup_minutes : undefined),
      });
      const proposal = this.writer.proposalOf(event, {
        scheduledStart,
        scheduledEnd,
        setupMinutes: buffers.setupMinutes,
        cleanupMinutes: buffers.cleanupMinutes,
        resourceIds,
      });
      const published = event.status === 'published';
      if (published) {
        await this.writer.detectOrThrow(trx, organizationId, facility, [proposal], [event.id]);
        await this.writer.release(trx, organizationId, event.id);
      }
      const updated = await trx
        .updateTable('events')
        .set({
          scheduled_start: scheduledStart,
          scheduled_end: scheduledEnd,
          setup_minutes: proposal.setupMinutes,
          cleanup_minutes: proposal.cleanupMinutes,
          resource_ids: proposal.resourceIds,
          revision: event.revision + 1,
          published_revision: published ? event.revision + 1 : null,
        })
        .where('organization_id', '=', organizationId)
        .where('id', '=', event.id)
        .where('revision', '=', event.revision)
        .returningAll()
        .executeTakeFirstOrThrow();
      if (published) await this.writer.reserve(trx, updated, facility);
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: 'scheduling.event_moved',
        targetType: 'event',
        targetId: event.id,
        beforeRevision: event.revision,
        afterRevision: updated.revision,
        reason: input.reason ?? null,
        correlationId: input.correlationId ?? null,
      });
      if (published) {
        await this.writer.notifyChanged(trx, {
          organizationId,
          event: updated,
          change:
            before.scheduledStart === updated.scheduled_start.toISOString() &&
            before.scheduledEnd === updated.scheduled_end.toISOString()
              ? 'resource_changed'
              : 'moved',
          before,
          after: await this.writer.details(trx, updated),
          reason: input.reason ?? null,
          correlationId: input.correlationId ?? null,
        });
      }
      return this.writer.view(updated);
    });
  }

  async cancelEvent(
    principal: Principal,
    eventId: string,
    input: CancelEventInput,
  ): Promise<Event> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const event = await this.writer.loadEvent(trx, organizationId, eventId, { forUpdate: true });
      if (!event) throw errors.protectedNotFound('event');
      await this.authorization.require(principal, SchedulingActions.manageEvents, {
        type: 'event',
        id: event.id,
        organizationId,
        facilityId: event.facility_id,
      });
      assertExpectedRevision(input.expectedRevision, event.revision);
      EventMachine.next(event.status, 'cancel');
      const wasPublished = event.status === 'published';
      const before = await this.writer.details(trx, event);
      const canceled = await this.writer.cancel(trx, event, input.reason);
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: 'scheduling.event_canceled',
        targetType: 'event',
        targetId: event.id,
        beforeRevision: event.revision,
        afterRevision: canceled.revision,
        reason: input.reason,
        correlationId: input.correlationId ?? null,
      });
      if (wasPublished) {
        await this.writer.notifyChanged(trx, {
          organizationId,
          event: canceled,
          change: 'canceled',
          before,
          after: null,
          reason: input.reason,
          correlationId: input.correlationId ?? null,
        });
      }
      return this.writer.view(canceled);
    });
  }

  /** Staff in scope, a committed participant (self) or a guardian with view permission; otherwise not found (§4.10). */
  async getEvent(principal: Principal, eventId: string): Promise<Event> {
    const organizationId = organizationOf(principal);
    const event = await executorFor(this.db)
      .selectFrom('events')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', eventId)
      .executeTakeFirst();
    if (!event) throw errors.protectedNotFound('event');
    const subjects = this.writer
      .commitmentsOf(event)
      .filter((c) => c.partyType === 'person')
      .map((c) => c.partyId);
    await this.authorization.require(principal, SchedulingActions.readEvent, {
      type: 'event',
      id: event.id,
      organizationId,
      facilityId: event.facility_id,
      subjectPersonIds: subjects,
      protected: true,
    });
    return this.writer.view(event);
  }

  async listEvents(principal: Principal, query: ListEventsQuery): Promise<Page<Event>> {
    const organizationId = organizationOf(principal);
    await this.authorization.require(principal, SchedulingActions.readSchedule, {
      type: 'schedule',
      organizationId,
      facilityId: query.facilityId,
    });
    const cursor = decodeCursor(query.cursor, Cursor);
    let q = executorFor(this.db)
      .selectFrom('events')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('facility_id', '=', query.facilityId)
      .where('scheduled_start', '<', new Date(query.end))
      .where('scheduled_end', '>', new Date(query.start))
      .orderBy('scheduled_start')
      .orderBy('id')
      .limit(query.limit + 1);
    if (query.status) q = q.where('status', '=', query.status);
    if (query.sourceType) q = q.where('source_type', '=', query.sourceType);
    if (query.sourceId) q = q.where('source_id', '=', query.sourceId);
    if (query.resourceId) {
      q = q.where(sql<boolean>`resource_ids @> array[${query.resourceId}]::uuid[]`);
    }
    if (cursor) {
      q = q.where(
        sql<boolean>`(scheduled_start, id) > (${new Date(cursor.start)}::timestamptz, ${cursor.id}::uuid)`,
      );
    }
    const rows = await q.execute();
    const items = rows.slice(0, query.limit).map((r) => this.writer.view(r));
    const last = rows.length > query.limit ? rows[query.limit - 1] : undefined;
    return {
      items,
      nextCursor: last
        ? encodeCursor({ start: new Date(last.scheduled_start).toISOString(), id: last.id })
        : null,
    };
  }

  async listReservations(principal: Principal, query: ReservationQuery): Promise<Reservation[]> {
    const organizationId = organizationOf(principal);
    let facilityId = query.facilityId ?? null;
    if (query.resourceId) {
      const resource = await executorFor(this.db)
        .selectFrom('resources')
        .select(['facility_id'])
        .where('organization_id', '=', organizationId)
        .where('id', '=', query.resourceId)
        .executeTakeFirst();
      if (!resource) throw errors.notFound('resource', query.resourceId);
      facilityId = resource.facility_id;
    }
    if (!facilityId) throw errors.validation('facilityId or resourceId is required.');
    await this.authorization.require(principal, SchedulingActions.readSchedule, {
      type: 'schedule',
      organizationId,
      facilityId,
    });
    let q = executorFor(this.db)
      .selectFrom('reservations as r')
      .innerJoin('events as e', (join) =>
        join.onRef('e.id', '=', 'r.event_id').onRef('e.organization_id', '=', 'r.organization_id'),
      )
      .select([
        'r.id',
        'r.event_id',
        'r.resource_id',
        'r.status',
        sql<string>`lower(r.occupied)`.as('start'),
        sql<string>`upper(r.occupied)`.as('end'),
      ])
      .where('r.organization_id', '=', organizationId)
      .where('e.facility_id', '=', facilityId)
      .where(sql<boolean>`r.occupied && ${tstzrange(query.interval.start, query.interval.end)}`)
      .orderBy(sql`lower(r.occupied)`)
      .orderBy('r.id');
    if (query.resourceId) q = q.where('r.resource_id', '=', query.resourceId);
    if (!query.includeReleased) q = q.where('r.status', '=', 'active');
    const rows = await q.execute();
    return rows.map((r) => ({
      id: r.id,
      eventId: r.event_id,
      resourceId: r.resource_id,
      occupied: { start: new Date(r.start).toISOString(), end: new Date(r.end).toISOString() },
      status: r.status,
    }));
  }

  /** Candidate scheduled intervals where the resource's units are free of reservations and closures and within operating hours. */
  async findAvailableSlots(
    principal: Principal,
    input: FindAvailableSlotsInput,
  ): Promise<Interval[]> {
    const organizationId = organizationOf(principal);
    const resource = await executorFor(this.db)
      .selectFrom('resources')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', input.resourceId)
      .executeTakeFirst();
    if (!resource) throw errors.notFound('resource', input.resourceId);
    await this.authorization.require(principal, SchedulingActions.readSchedule, {
      type: 'schedule',
      organizationId,
      facilityId: resource.facility_id,
    });
    if (resource.status === 'closed') return [];
    const facility = await executorFor(this.db)
      .selectFrom('facilities')
      .select(['id', 'organization_id', 'timezone', 'settings'])
      .where('organization_id', '=', organizationId)
      .where('id', '=', resource.facility_id)
      .executeTakeFirstOrThrow();
    const policy = this.writer.policyFor(facility);
    // the same buffers createEvent would hold on this resource (SPK-SCHED-003)
    const { setupMinutes: setup, cleanupMinutes: cleanup } = this.writer.effectiveBuffers(
      [resource],
      input,
    );
    const step = (input.stepMinutes ?? policy.availabilityStepMinutes) * 60_000;
    const duration = input.durationMinutes * 60_000;
    const windowStart = new Date(input.interval.start);
    const windowEnd = new Date(input.interval.end);
    const searchStart = new Date(windowStart.getTime() - setup * 60_000);
    const searchEnd = new Date(windowEnd.getTime() + cleanup * 60_000);

    const units = await executorFor(this.db)
      .selectFrom('resource_conflict_units')
      .select('conflict_unit_id')
      .where('organization_id', '=', organizationId)
      .where('resource_id', '=', resource.id)
      .execute();
    const unitIds = units.map((u) => u.conflict_unit_id);
    const busy: Array<{ start: number; end: number }> = [];
    if (unitIds.length > 0) {
      const reserved = await executorFor(this.db)
        .selectFrom('reservation_units')
        .select([sql<string>`lower(occupied)`.as('start'), sql<string>`upper(occupied)`.as('end')])
        .where('organization_id', '=', organizationId)
        .where('status', '=', 'active')
        .where('conflict_unit_id', 'in', unitIds)
        .where(sql<boolean>`occupied && ${tstzrange(searchStart, searchEnd)}`)
        .execute();
      for (const r of reserved) {
        busy.push({ start: new Date(r.start).getTime(), end: new Date(r.end).getTime() });
      }
      const closures = await executorFor(this.db)
        .selectFrom('closures')
        .select([sql<string>`lower(during)`.as('start'), sql<string>`upper(during)`.as('end')])
        .where('organization_id', '=', organizationId)
        .where('facility_id', '=', resource.facility_id)
        .where('status', '=', 'active')
        .where(sql<boolean>`during && ${tstzrange(searchStart, searchEnd)}`)
        .where((eb) =>
          eb.or([
            eb('resource_id', 'is', null),
            eb(
              'resource_id',
              'in',
              eb
                .selectFrom('resource_conflict_units')
                .select('resource_id')
                .where('organization_id', '=', organizationId)
                .where('conflict_unit_id', 'in', unitIds),
            ),
          ]),
        )
        .execute();
      for (const c of closures) {
        busy.push({ start: new Date(c.start).getTime(), end: new Date(c.end).getTime() });
      }
    }
    const hours = await executorFor(this.db)
      .selectFrom('operating_hours')
      .select(['resource_id', 'weekday', 'opens_at', 'closes_at'])
      .where('organization_id', '=', organizationId)
      .where('facility_id', '=', resource.facility_id)
      .where((eb) => eb.or([eb('resource_id', '=', resource.id), eb('resource_id', 'is', null)]))
      .execute();
    let windows = hours.filter((h) => h.resource_id === resource.id);
    if (windows.length === 0) windows = hours.filter((h) => h.resource_id === null);

    const slots: Interval[] = [];
    for (let s = windowStart.getTime(); s + duration <= windowEnd.getTime(); s += step) {
      const occupiedStart = s - setup * 60_000;
      const occupiedEnd = s + duration + cleanup * 60_000;
      if (busy.some((b) => b.start < occupiedEnd && occupiedStart < b.end)) continue;
      if (windows.length > 0) {
        // SPK-SCHED-008: the slot's local wall-clock end, not start plus elapsed minutes
        const span = localMinuteSpan(facility.timezone, new Date(s), new Date(s + duration));
        const fits = windows.some(
          (w) =>
            w.weekday === span.weekday &&
            minutesOf(w.opens_at) <= span.startMinute &&
            span.endMinute <= minutesOf(w.closes_at),
        );
        if (!fits) continue;
      }
      slots.push({ start: new Date(s).toISOString(), end: new Date(s + duration).toISOString() });
    }
    return slots;
  }
}
