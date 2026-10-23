import { Inject, Injectable } from '@nestjs/common';
import {
  errors,
  newId,
  PartyCommitmentSchema,
  type DomainEvent,
  type Event,
  type EventDetails,
  type PartyCommitment,
  type Principal,
} from '@sportspark/contracts';
import {
  isExclusionViolation,
  json,
  tstzrange,
  type Db,
  type EventKind,
  type EventsTable,
  type ResourcesTable,
} from '@sportspark/db';
import { sql, type Selectable } from 'kysely';
import { Outbox, type Clock, type Trx } from '../../../kernel';
import { CLOCK } from '../../../kernel/tokens';
import {
  ConflictDetector,
  type DetectedConflict,
  type ProposedEvent,
} from '../conflicts/conflict-detector';
import { EventChanged, type EventChangeKind } from '../scheduling.events';
import { policyForFacility, SCHEDULING_POLICY, type SchedulingPolicy } from '../scheduling.policy';

export type EventRow = Selectable<EventsTable>;
export type ResourceRow = Selectable<ResourcesTable>;

export interface FacilityRow {
  id: string;
  organization_id: string;
  timezone: string;
  settings: Record<string, unknown>;
}

export interface NewEventData {
  organizationId: string;
  facilityId: string;
  timezone: string;
  kind: EventKind;
  title: string;
  format: string | null;
  seriesId?: string | null;
  occurrenceIndex?: number | null;
  scheduledStart: Date;
  scheduledEnd: Date;
  setupMinutes: number;
  cleanupMinutes: number;
  dstResolution?: 'exact' | 'shifted_forward' | 'first' | 'second';
  status: 'draft' | 'published';
  resourceIds: string[];
  commitments: PartyCommitment[];
  sourceType: string | null;
  sourceId: string | null;
}

export interface ChangeNotice {
  organizationId: string;
  event: EventRow;
  change: EventChangeKind;
  before: EventDetails | null;
  after: EventDetails | null;
  publicationId?: string | null;
  closureId?: string | null;
  reason?: string | null;
  correlationId?: string | null;
  operationId?: string | null;
}

let savepointCounter = 0;

/**
 * Transactional primitives shared by the direct scheduling port, series and publication: insert
 * events, hold and release reservations/units/commitments, and enqueue change notices. Callers
 * authorize before using it. Exclusion violations (the database guarantee, §4.7 invariant 4) are
 * converted to RESOURCE_CONFLICT naming the conflicting event ids.
 */
@Injectable()
export class EventWriter {
  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(SCHEDULING_POLICY) private readonly basePolicy: SchedulingPolicy,
    private readonly outbox: Outbox,
    private readonly detector: ConflictDetector,
  ) {}

  async loadFacility(db: Db, organizationId: string, facilityId: string): Promise<FacilityRow> {
    const row = await db
      .selectFrom('facilities')
      .select(['id', 'organization_id', 'timezone', 'settings'])
      .where('organization_id', '=', organizationId)
      .where('id', '=', facilityId)
      .executeTakeFirst();
    if (!row) throw errors.notFound('facility', facilityId);
    return row;
  }

  policyFor(facility: FacilityRow): SchedulingPolicy {
    return policyForFacility(this.basePolicy, facility.settings);
  }

  async loadEvent(
    db: Db,
    organizationId: string,
    eventId: string,
    options: { forUpdate?: boolean } = {},
  ): Promise<EventRow | undefined> {
    let query = db
      .selectFrom('events')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', eventId);
    if (options.forUpdate) query = query.forUpdate();
    return query.executeTakeFirst();
  }

  async loadResources(
    db: Db,
    organizationId: string,
    facilityId: string,
    resourceIds: string[],
  ): Promise<ResourceRow[]> {
    const unique = [...new Set(resourceIds)];
    if (unique.length === 0) throw errors.validation('At least one resource is required.');
    const rows = await db
      .selectFrom('resources')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('facility_id', '=', facilityId)
      .where('id', 'in', unique)
      .execute();
    const missing = unique.filter((id) => !rows.some((r) => r.id === id));
    if (missing.length > 0) {
      throw errors.validation('Unknown resource for this facility.', { resourceIds: missing });
    }
    return unique.map((id) => rows.find((r) => r.id === id) as ResourceRow);
  }

  /** Buffers default to the largest default among the requested resources (SPK-SCHED-003). */
  defaultBuffers(resources: ResourceRow[]): { setupMinutes: number; cleanupMinutes: number } {
    return {
      setupMinutes: Math.max(0, ...resources.map((r) => r.default_setup_minutes)),
      cleanupMinutes: Math.max(0, ...resources.map((r) => r.default_cleanup_minutes)),
    };
  }

  async detectOrThrow(
    trx: Trx,
    organizationId: string,
    facility: FacilityRow,
    proposals: ProposedEvent[],
    ignoreEventIds: string[] = [],
  ): Promise<DetectedConflict[]> {
    const conflicts = await this.detector.detect(
      trx,
      organizationId,
      { id: facility.id, timezone: facility.timezone },
      proposals,
      { policy: this.policyFor(facility), ignoreEventIds },
    );
    const blocking = conflicts.filter((c) => c.severity === 'error');
    if (blocking.length > 0) throw this.conflictError(blocking);
    return conflicts;
  }

  conflictError(conflicts: DetectedConflict[]): Error {
    const eventIds = [...new Set(conflicts.flatMap((c) => c.detail.conflictingEventIds))];
    return errors.resourceConflict('The proposed schedule conflicts with existing commitments.', {
      conflicts: conflicts.map((c) => ({ key: c.key, ...c.detail })),
      conflictingEventIds: eventIds,
    });
  }

  async insertEvent(trx: Trx, data: NewEventData): Promise<EventRow> {
    const id = newId();
    const commitments = data.commitments.map((c) => PartyCommitmentSchema.parse(c));
    const row = await trx
      .insertInto('events')
      .values({
        id,
        organization_id: data.organizationId,
        facility_id: data.facilityId,
        kind: data.kind,
        title: data.title,
        format: data.format,
        series_id: data.seriesId ?? null,
        occurrence_index: data.occurrenceIndex ?? null,
        scheduled_start: data.scheduledStart,
        scheduled_end: data.scheduledEnd,
        timezone: data.timezone,
        setup_minutes: data.setupMinutes,
        cleanup_minutes: data.cleanupMinutes,
        dst_resolution: data.dstResolution ?? 'exact',
        status: data.status,
        published_revision: data.status === 'published' ? 1 : null,
        resource_ids: data.resourceIds,
        commitments: json(commitments),
        source_type: data.sourceType,
        source_id: data.sourceId,
        canceled_at: null,
        cancel_reason: null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return row;
  }

  /**
   * Holds the event's resources (every conflict unit of every resource, for the occupied interval)
   * and its party commitments (for the scheduled interval). A savepoint lets a constraint failure
   * be turned into a RESOURCE_CONFLICT that names the colliding events without aborting the
   * caller's transaction.
   */
  async reserve(trx: Trx, event: EventRow, facility: FacilityRow): Promise<void> {
    const resourceIds = event.resource_ids;
    const commitments = this.commitmentsOf(event);
    const units =
      resourceIds.length === 0
        ? []
        : await trx
            .selectFrom('resource_conflict_units')
            .select(['resource_id', 'conflict_unit_id'])
            .where('organization_id', '=', event.organization_id)
            .where('resource_id', 'in', resourceIds)
            .execute();
    const occupied = tstzrange(
      new Date(new Date(event.scheduled_start).getTime() - event.setup_minutes * 60_000),
      new Date(new Date(event.scheduled_end).getTime() + event.cleanup_minutes * 60_000),
    );
    const scheduled = tstzrange(event.scheduled_start, event.scheduled_end);
    savepointCounter += 1;
    const savepoint = sql.id(`reserve_${savepointCounter}`);
    await sql`savepoint ${savepoint}`.execute(trx);
    try {
      for (const resourceId of resourceIds) {
        const reservationId = newId();
        await trx
          .insertInto('reservations')
          .values({
            id: reservationId,
            organization_id: event.organization_id,
            event_id: event.id,
            resource_id: resourceId,
            occupied,
            released_at: null,
          })
          .execute();
        const resourceUnits = units.filter((u) => u.resource_id === resourceId);
        if (resourceUnits.length === 0) {
          throw errors.validation('The resource has no conflict units and cannot be reserved.', {
            resourceId,
          });
        }
        for (const unit of resourceUnits) {
          await trx
            .insertInto('reservation_units')
            .values({
              id: newId(),
              organization_id: event.organization_id,
              reservation_id: reservationId,
              event_id: event.id,
              conflict_unit_id: unit.conflict_unit_id,
              occupied,
            })
            .execute();
        }
      }
      for (const commitment of commitments) {
        await trx
          .insertInto('event_commitments')
          .values({
            id: newId(),
            organization_id: event.organization_id,
            event_id: event.id,
            party_type: commitment.partyType,
            party_id: commitment.partyId,
            role: commitment.role,
            occupied: scheduled,
          })
          .execute();
      }
      await sql`release savepoint ${savepoint}`.execute(trx);
    } catch (error) {
      if (!isExclusionViolation(error)) throw error;
      await sql`rollback to savepoint ${savepoint}`.execute(trx);
      const conflicts = await this.detector.detect(
        trx,
        event.organization_id,
        { id: facility.id, timezone: facility.timezone },
        [this.proposalOf(event)],
        { policy: this.policyFor(facility) },
      );
      const blocking = conflicts.filter((c) => c.severity === 'error');
      throw blocking.length > 0
        ? this.conflictError(blocking)
        : errors.resourceConflict('A concurrent reservation took the space.', {
            conflicts: [],
            conflictingEventIds: [],
          });
    }
  }

  /** Releases every active reservation, unit and commitment of the event (frees the units). */
  async release(trx: Trx, organizationId: string, eventId: string): Promise<void> {
    const now = this.clock.now();
    await trx
      .updateTable('reservation_units')
      .set({ status: 'released' })
      .where('organization_id', '=', organizationId)
      .where('event_id', '=', eventId)
      .where('status', '=', 'active')
      .execute();
    await trx
      .updateTable('reservations')
      .set({ status: 'released', released_at: now })
      .where('organization_id', '=', organizationId)
      .where('event_id', '=', eventId)
      .where('status', '=', 'active')
      .execute();
    await trx
      .updateTable('event_commitments')
      .set({ status: 'released' })
      .where('organization_id', '=', organizationId)
      .where('event_id', '=', eventId)
      .where('status', '=', 'active')
      .execute();
  }

  commitmentsOf(event: EventRow): PartyCommitment[] {
    return (event.commitments as unknown[]).map((c) => PartyCommitmentSchema.parse(c));
  }

  proposalOf(event: EventRow, overrides: Partial<ProposedEvent> = {}): ProposedEvent {
    return {
      key: event.id,
      eventId: event.id,
      kind: event.kind,
      format: event.format,
      scheduledStart: new Date(event.scheduled_start),
      scheduledEnd: new Date(event.scheduled_end),
      setupMinutes: event.setup_minutes,
      cleanupMinutes: event.cleanup_minutes,
      resourceIds: event.resource_ids,
      commitments: this.commitmentsOf(event),
      ...overrides,
    };
  }

  async details(db: Db, event: EventRow): Promise<EventDetails> {
    const resources =
      event.resource_ids.length === 0
        ? []
        : await db
            .selectFrom('resources')
            .select(['id', 'name'])
            .where('organization_id', '=', event.organization_id)
            .where('id', 'in', event.resource_ids)
            .execute();
    return {
      title: event.title,
      kind: event.kind,
      scheduledStart: new Date(event.scheduled_start).toISOString(),
      scheduledEnd: new Date(event.scheduled_end).toISOString(),
      timezone: event.timezone,
      facilityId: event.facility_id,
      resources: event.resource_ids.map((id) => ({
        id,
        name: resources.find((r) => r.id === id)?.name ?? '',
      })),
      status: event.status,
    };
  }

  view(event: EventRow): Event {
    return {
      id: event.id,
      facilityId: event.facility_id,
      kind: event.kind,
      title: event.title,
      format: event.format,
      seriesId: event.series_id,
      occurrenceIndex: event.occurrence_index,
      scheduledStart: new Date(event.scheduled_start).toISOString(),
      scheduledEnd: new Date(event.scheduled_end).toISOString(),
      timezone: event.timezone,
      setupMinutes: event.setup_minutes,
      cleanupMinutes: event.cleanup_minutes,
      dstResolution: event.dst_resolution,
      status: event.status,
      publishedRevision: event.published_revision,
      revision: event.revision,
      sourceType: event.source_type,
      sourceId: event.source_id,
      resourceIds: event.resource_ids,
      commitments: this.commitmentsOf(event),
      canceledAt: event.canceled_at ? new Date(event.canceled_at).toISOString() : null,
      cancelReason: event.cancel_reason,
      createdAt: new Date(event.created_at).toISOString(),
      updatedAt: new Date(event.updated_at).toISOString(),
    };
  }

  /** Enqueues scheduling.event_changed with old and new practical details (SPK-COMMS-005). */
  async notifyChanged(trx: Trx, notice: ChangeNotice): Promise<DomainEvent<unknown>> {
    return this.outbox.enqueue(trx, EventChanged, {
      organizationId: notice.organizationId,
      aggregateType: 'event',
      aggregateId: notice.event.id,
      correlationId: notice.correlationId ?? null,
      operationId: notice.operationId ?? null,
      payload: {
        eventId: notice.event.id,
        facilityId: notice.event.facility_id,
        change: notice.change,
        before: notice.before,
        after: notice.after,
        sourceType: notice.event.source_type,
        sourceId: notice.event.source_id,
        seriesId: notice.event.series_id,
        commitments: this.commitmentsOf(notice.event).map((c) => ({
          partyType: c.partyType,
          partyId: c.partyId,
        })),
        publicationId: notice.publicationId ?? null,
        closureId: notice.closureId ?? null,
        reason: notice.reason ?? null,
      },
    });
  }

  /** Cancels a published or draft event: releases its holds and records the reason. */
  async cancel(
    trx: Trx,
    event: EventRow,
    reason: string,
    nextStatus: 'canceled' = 'canceled',
  ): Promise<EventRow> {
    await this.release(trx, event.organization_id, event.id);
    return trx
      .updateTable('events')
      .set({
        status: nextStatus,
        canceled_at: this.clock.now(),
        cancel_reason: reason,
        revision: event.revision + 1,
      })
      .where('organization_id', '=', event.organization_id)
      .where('id', '=', event.id)
      .where('revision', '=', event.revision)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  snapshotActor(principal: Principal): Record<string, unknown> {
    return {
      kind: principal.kind,
      accountId: principal.accountId,
      actorLabel: principal.actorLabel,
    };
  }
}
