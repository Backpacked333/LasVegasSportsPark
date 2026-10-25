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

/** Whether two resource-id lists name the same set of resources. */
export function sameResourceSet(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((id) => right.has(id));
}

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
  defaultBuffers(
    resources: Array<Pick<ResourceRow, 'default_setup_minutes' | 'default_cleanup_minutes'>>,
  ): { setupMinutes: number; cleanupMinutes: number } {
    return {
      setupMinutes: Math.max(0, ...resources.map((r) => r.default_setup_minutes)),
      cleanupMinutes: Math.max(0, ...resources.map((r) => r.default_cleanup_minutes)),
    };
  }

  /**
   * SPK-SCHED-001/003: each resource's default setup and cleanup is its turnover requirement, so
   * the buffers actually held are at least the largest default among the reserved resources. A
   * larger requested value extends them; a smaller one is raised to the requirement.
   */
  effectiveBuffers(
    resources: Array<Pick<ResourceRow, 'default_setup_minutes' | 'default_cleanup_minutes'>>,
    requested: { setupMinutes?: number | null; cleanupMinutes?: number | null } = {},
  ): { setupMinutes: number; cleanupMinutes: number } {
    const floor = this.defaultBuffers(resources);
    return {
      setupMinutes: Math.max(requested.setupMinutes ?? 0, floor.setupMinutes),
      cleanupMinutes: Math.max(requested.cleanupMinutes ?? 0, floor.cleanupMinutes),
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
    // §4.7 invariant 4: the resource rows are share-locked before their unit mapping is read, so an
    // inventory change that adds units (and extends existing holds) is either seen here or sees us.
    await this.lockResources(trx, event.organization_id, resourceIds);
    const units =
      resourceIds.length === 0
        ? []
        : await trx
            .selectFrom('resource_conflict_units')
            .select(['resource_id', 'conflict_unit_id'])
            .where('organization_id', '=', event.organization_id)
            .where('resource_id', 'in', resourceIds)
            .execute();
    const occupiedStart = new Date(
      new Date(event.scheduled_start).getTime() - event.setup_minutes * 60_000,
    );
    const occupiedEnd = new Date(
      new Date(event.scheduled_end).getTime() + event.cleanup_minutes * 60_000,
    );
    const occupied = tstzrange(occupiedStart, occupiedEnd);
    const scheduled = tstzrange(event.scheduled_start, event.scheduled_end);

    // SPK-SCHED-009 / SPK-FAC-003: closures hold no reservation rows, so a closure applied after
    // detection is caught here. The share locks wait for an apply that holds the units FOR UPDATE;
    // the re-check is a new statement and therefore sees a closure that committed meanwhile.
    const unitIds = [...new Set(units.map((u) => u.conflict_unit_id))].sort();
    await this.lockUnits(trx, event.organization_id, unitIds);
    const closures = await this.detector.activeClosures(
      trx,
      event.organization_id,
      facility.id,
      unitIds,
      { start: occupiedStart, end: occupiedEnd },
    );
    // SPK-SCHED-004: the rest gap has no exclusion constraint; the per-party lock serializes
    // commands for the same party and the re-check after it sees a commitment committed meanwhile.
    await this.lockParties(trx, event.organization_id, facility, commitments);
    const tooClose = await this.restViolations(trx, event, facility, commitments);
    const rechecked = [...closures, ...tooClose].map((detail) => ({
      key: event.id,
      severity: 'error' as const,
      detail,
    }));
    if (rechecked.length > 0) throw this.conflictError(rechecked);
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
            facility_id: event.facility_id,
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

  /**
   * Takes, up front and in one global order, every lock `reserve` takes for the given events, so a
   * command that reserves several events (publication, series edit) cannot deadlock with another
   * one that takes the same locks in a different order. `reserve` re-acquires them as a no-op.
   */
  async lockHolds(
    trx: Trx,
    organizationId: string,
    facility: FacilityRow,
    holds: Array<{ resourceIds: string[]; commitments: PartyCommitment[] }>,
  ): Promise<void> {
    const resourceIds = [...new Set(holds.flatMap((h) => h.resourceIds))];
    await this.lockResources(trx, organizationId, resourceIds);
    if (resourceIds.length > 0) {
      const units = await trx
        .selectFrom('resource_conflict_units')
        .select('conflict_unit_id')
        .where('organization_id', '=', organizationId)
        .where('resource_id', 'in', resourceIds)
        .execute();
      await this.lockUnits(trx, organizationId, [...new Set(units.map((u) => u.conflict_unit_id))]);
    }
    await this.lockParties(
      trx,
      organizationId,
      facility,
      holds.flatMap((h) => h.commitments),
    );
  }

  private async lockResources(
    trx: Trx,
    organizationId: string,
    resourceIds: string[],
  ): Promise<void> {
    const ids = [...new Set(resourceIds)].sort();
    if (ids.length === 0) return;
    await trx
      .selectFrom('resources')
      .select('id')
      .where('organization_id', '=', organizationId)
      .where('id', 'in', ids)
      .orderBy('id')
      .forShare()
      .execute();
  }

  private async lockUnits(trx: Trx, organizationId: string, unitIds: string[]): Promise<void> {
    const ids = [...new Set(unitIds)].sort();
    if (ids.length === 0) return;
    await trx
      .selectFrom('conflict_units')
      .select('id')
      .where('organization_id', '=', organizationId)
      .where('id', 'in', ids)
      .orderBy('id')
      .forShare()
      .execute();
  }

  /** Transaction-scoped advisory lock per committed party that needs rest (SPK-SCHED-004). */
  private async lockParties(
    trx: Trx,
    organizationId: string,
    facility: FacilityRow,
    commitments: PartyCommitment[],
  ): Promise<void> {
    const rest = this.policyFor(facility).requiredRestMinutes;
    const keys = [
      ...new Set(
        commitments
          .filter((c) => (rest[c.partyType] ?? 0) > 0)
          .map((c) => `scheduling.party:${organizationId}:${c.partyType}:${c.partyId}`),
      ),
    ].sort();
    for (const key of keys) {
      await sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`.execute(trx);
    }
  }

  /** Active commitments of the same parties closer than the required rest (not overlapping: the exclusion constraint covers those). */
  private async restViolations(
    trx: Trx,
    event: EventRow,
    facility: FacilityRow,
    commitments: PartyCommitment[],
  ) {
    const rest = this.policyFor(facility).requiredRestMinutes;
    const start = new Date(event.scheduled_start).getTime();
    const end = new Date(event.scheduled_end).getTime();
    const details: DetectedConflict['detail'][] = [];
    const seen = new Set<string>();
    for (const c of commitments) {
      const minutes = rest[c.partyType] ?? 0;
      const party = `${c.partyType}:${c.partyId}`;
      if (minutes <= 0 || seen.has(party)) continue;
      seen.add(party);
      const rows = await trx
        .selectFrom('event_commitments')
        .select([
          'event_id',
          sql<string>`lower(occupied)`.as('start'),
          sql<string>`upper(occupied)`.as('end'),
        ])
        .where('organization_id', '=', event.organization_id)
        .where('status', '=', 'active')
        .where('party_type', '=', c.partyType)
        .where('party_id', '=', c.partyId)
        .where('event_id', '<>', event.id)
        .where(
          sql<boolean>`occupied && ${tstzrange(
            new Date(start - minutes * 60_000),
            new Date(end + minutes * 60_000),
          )}`,
        )
        .execute();
      const close = rows.filter(
        (r) => !(new Date(r.start).getTime() < end && start < new Date(r.end).getTime()),
      );
      if (close.length === 0) continue;
      details.push({
        code: 'insufficient_rest',
        message: `The ${c.partyType} needs ${minutes} minutes of rest between commitments.`,
        party: { partyType: c.partyType, partyId: c.partyId },
        conflictingEventIds: [...new Set(close.map((r) => r.event_id))].sort(),
      });
    }
    return details;
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
        // every caller passes the post-change row
        revision: notice.event.revision,
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
    const canceled = await trx
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
      .executeTakeFirst();
    if (!canceled) throw await this.staleEvent(trx, event);
    return canceled;
  }

  /**
   * §4.9: the error for a revision-matched event update that changed no row. Another command moved
   * the event after it was read; the caller retries on the current revision (STALE_REVISION), never
   * an unmapped internal error.
   */
  async staleEvent(trx: Trx, event: EventRow): Promise<Error> {
    const current = await trx
      .selectFrom('events')
      .select('revision')
      .where('organization_id', '=', event.organization_id)
      .where('id', '=', event.id)
      .executeTakeFirst();
    if (!current) return errors.protectedNotFound('event');
    return errors.staleRevision(event.revision, current.revision);
  }

  snapshotActor(principal: Principal): Record<string, unknown> {
    return {
      kind: principal.kind,
      accountId: principal.accountId,
      actorLabel: principal.actorLabel,
    };
  }
}
