import { Inject, Injectable } from '@nestjs/common';
import {
  DomainError,
  errors,
  newId,
  type OfflineItem,
  type OfflineItemResult,
  type OfflineSyncBatch,
  type OfflineSyncBody,
  type Principal,
} from '@sportspark/contracts';
import { isUniqueViolation, json, pgConstraintName, type Db } from '@sportspark/db';
import { sql } from 'kysely';
import {
  AuditWriter,
  AuthorizationService,
  canonicalHash,
  CLOCK,
  OperationalExceptions,
  OperationsService,
  Outbox,
  snapshotActor,
  UnitOfWork,
  type Clock,
  type Trx,
} from '../../../kernel';
import { PERSON_DIRECTORY_PORT, type PersonDirectoryPort } from '../../identity';
import { EntryActions } from '../entry.actions';
import { EntryEvents } from '../entry.events';
import { ENTRY_POLICY, policyForFacility, type EntryPolicy } from '../entry.policy';
import { addMinutes, organizationOf, toBatch, type BatchRow, type VisitRow } from '../entry.shared';
import {
  activityKey,
  ActivityResolver,
  type FacilityFacts,
  type ResolvedActivity,
} from './activity-resolver';
import { AttendanceService } from './attendance.service';
import { denialReasonFor, ReleasesService } from './releases.service';
import { StaffScope } from './staff-scope';
import { attendanceLockKey, lockEntrySubjects, presenceLockKey } from './subject-locks';
import { VisitsService } from './visits.service';

/** A departure synchronized while the person had no open visit, kept for review (§4.15). */
const UNMATCHED_DEPARTURE = 'entry.offline_departure_unmatched';
/** A queued release or child departure that could not be recorded as a verified release. */
const UNRECORDED_RELEASE = 'entry.offline_release_unrecorded';

interface UnmatchedDepartureDetails {
  personId: string;
  observedAt: string;
  deviceId: string;
  clientObservationId: string;
  batchId: string;
}

interface BatchContext {
  principal: Principal;
  organizationId: string;
  facility: FacilityFacts;
  policy: EntryPolicy;
  desk: boolean;
  /** The principal holds entry.record_release at the facility (the online pickup desk roles). */
  releaseDesk: boolean;
  /** Per activity: entry.record_assigned_release is held and the principal is assigned to it. */
  releaseAssigned: Map<string, boolean>;
  batchId: string;
  deviceId: string;
  snapshotReference: string;
  snapshotTakenAt: Date;
  receivedAt: Date;
  activities: Map<string, ResolvedActivity | null>;
  assigned: Map<string, boolean>;
  correlationId: string | null;
  exceptionIds: Set<string>;
}

const result = (
  item: OfflineItem,
  outcome: OfflineItemResult['outcome'],
  reason: string | null,
  recordId: string | null,
  flags: readonly string[] = [],
): OfflineItemResult => ({
  clientObservationId: item.clientObservationId,
  kind: item.kind,
  outcome,
  reason,
  recordId,
  flags: [...flags],
});

/**
 * Offline synchronization (§4.15, SPK-AT-018). An approved staff device uploads the observations it
 * queued against a roster snapshot. Each item carries its unique client id, the observed time and
 * the snapshot reference; the actor is the signed-in principal and the received time is the
 * server clock. The batch is applied once:
 *   - a re-uploaded batch (same device and client batch id) returns the stored outcome only when
 *     its facility and contents match the stored request fingerprint; the same client batch id
 *     with different contents is a RESOURCE_CONFLICT `batch_id_reused` that reveals nothing about
 *     the stored batch (§4.9, §4.14);
 *   - an item already recorded (same device and client observation id) is a `duplicate`;
 *   - an item observed against a roster older than the maximum roster age (DEC-033, proposed two
 *     hours) is accepted but flagged `stale_snapshot`, and the batch is raised for review;
 *   - a conflicting observation is kept and raised for review (`accepted_with_conflict`);
 *   - a departure synchronized before the arrival it closes is kept for review
 *     (`entry.offline_departure_unmatched`), and closes the visit once that arrival synchronizes;
 *     an arrival synchronized after a release of the child closes through that release;
 *   - a queued release is REJECTED unless it names a separately approved manual outage procedure
 *     (DEC-005, DEC-034; none approved by default) and the principal may record that release
 *     online (entry.record_release, or entry.record_assigned_release for a child of the assigned
 *     activity). Even then authority is re-checked: `collect` must be held now AND at the recorded
 *     handover time, and a release made without it raises a critical exception — stale authority
 *     is never asserted;
 *   - every queued release that is rejected, and every child departure rejected because a
 *     release is required, raises a critical `entry.offline_release_unrecorded` exception: the
 *     device saw the child leave, so someone must confirm where the child is (§4.7 invariant 12).
 *     Whether such a release may be recorded as a fact depends on the outage procedure (DEC-034,
 *     DEC-005 pending); until then no authority is ever asserted for it.
 * Writes about one person (presence, attendance in one activity) are serialized by
 * transaction-scoped advisory locks taken up front in a stable order (subject-locks.ts).
 * Nothing offline can authorize payments, capacity, guardian changes or roster transfers: those
 * kinds do not exist in the batch contract.
 */
@Injectable()
export class OfflineSyncService {
  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ENTRY_POLICY) private readonly policy: EntryPolicy,
    @Inject(PERSON_DIRECTORY_PORT) private readonly people: PersonDirectoryPort,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly exceptions: OperationalExceptions,
    private readonly operations: OperationsService,
    private readonly resolver: ActivityResolver,
    private readonly scope: StaffScope,
    private readonly attendance: AttendanceService,
    private readonly visits: VisitsService,
    private readonly releases: ReleasesService,
  ) {}

  async sync(
    principal: Principal,
    body: OfflineSyncBody,
    correlationId: string | null,
  ): Promise<OfflineSyncBatch> {
    const organizationId = organizationOf(principal);
    await this.authorization.require(principal, EntryActions.syncOffline, {
      type: 'facility',
      id: body.facilityId,
      organizationId,
      facilityId: body.facilityId,
    });
    const facility = await this.resolver.facility(organizationId, body.facilityId);
    const fingerprint = requestFingerprint(body);
    const stored = await this.findBatch(this.uow.reader(), organizationId, body);
    if (stored) return replayOf(stored, body, fingerprint);

    const policy = policyForFacility(this.policy, facility.settings);
    const desk = this.scope.hasDeskRole(principal);
    const refs = body.items.flatMap((item) =>
      item.kind === 'attendance'
        ? [item.activity]
        : item.kind === 'release' && item.activity
          ? [item.activity]
          : [],
    );
    // Owning modules are read before the transaction (their services use the root connection).
    const activities = await this.resolver.resolveMany(organizationId, refs);
    const assigned = new Map<string, boolean>();
    if (!desk && principal.personId) {
      for (const [key, activity] of activities) {
        assigned.set(
          key,
          activity !== null &&
            (await this.scope.isAssigned(organizationId, activity, principal.personId)),
        );
      }
    }
    // §4.11 one action registry: a queued release needs the same authority as an online one
    // (SPK-ENTRY-007) — the pickup desk roles, or a coach assigned to the release's activity.
    const releaseDesk = (
      await this.authorization.decide(principal, EntryActions.recordRelease, {
        type: 'facility',
        id: body.facilityId,
        organizationId,
        facilityId: body.facilityId,
      })
    ).allowed;
    const releaseAssigned = new Map<string, boolean>();
    if (!releaseDesk && principal.personId) {
      for (const [key, activity] of activities) {
        if (!activity) continue;
        const field = await this.authorization.decide(
          principal,
          EntryActions.recordAssignedRelease,
          {
            type: 'activity',
            id: activity.detail.id,
            organizationId,
            facilityId: activity.facilityId,
          },
        );
        releaseAssigned.set(
          key,
          field.allowed &&
            (assigned.get(key) ??
              (await this.scope.isAssigned(organizationId, activity, principal.personId))),
        );
      }
    }
    try {
      return await this.uow.run(async ({ trx }) => {
        // Every per-subject lock the batch needs, up front and sorted, so two batches listing the
        // same people in opposite orders cannot deadlock (§4.15, SPK-AT-018).
        await lockEntrySubjects(trx, subjectLockKeys(organizationId, body.items, activities));
        const receivedAt = this.clock.now();
        const snapshotTakenAt = new Date(body.snapshot.takenAt);
        if (
          snapshotTakenAt.getTime() >
          addMinutes(receivedAt, policy.clockSkewToleranceMinutes).getTime()
        ) {
          throw errors.validation('The roster snapshot is dated in the future.', {
            code: 'snapshot_in_future',
          });
        }
        const batchId = newId();
        const operationId = await this.operations.create(trx, {
          organizationId,
          kind: 'entry.offline_sync',
          requestedBy: principal,
          correlationId,
          input: {
            deviceId: body.deviceId,
            clientBatchId: body.clientBatchId,
            items: body.items.length,
          },
          status: 'running',
        });
        const ctx: BatchContext = {
          principal,
          organizationId,
          facility,
          policy,
          desk,
          releaseDesk,
          releaseAssigned,
          batchId,
          deviceId: body.deviceId,
          snapshotReference: body.snapshot.reference,
          snapshotTakenAt,
          receivedAt,
          activities,
          assigned,
          correlationId,
          exceptionIds: new Set(),
        };
        const results: OfflineItemResult[] = [];
        for (const item of body.items) {
          const applied = await this.apply(trx, ctx, item);
          await this.followUpUnrecordedRelease(trx, ctx, item, applied);
          results.push(applied);
        }

        const applied = results.filter(
          (r) => r.outcome === 'accepted' || r.outcome === 'accepted_with_conflict',
        );
        const staleIds = applied.filter((r) => r.flags.includes('stale_snapshot'));
        if (staleIds.length > 0) {
          const raised = await this.exceptions.raise(trx, {
            organizationId,
            facilityId: facility.id,
            category: 'entry.stale_offline_snapshot',
            severity: 'warning',
            title: 'Offline observations were made against a roster older than the maximum age',
            affectedType: 'offline_sync_batch',
            affectedId: batchId,
            ownerQueue: policy.attendanceReviewQueue,
            dedupeKey: `entry.stale_offline_snapshot:${batchId}`,
            details: {
              batchId,
              deviceId: body.deviceId,
              maxRosterAgeMinutes: policy.maxRosterAgeMinutes,
              recordIds: staleIds.map((r) => r.recordId),
              nextAction: 'review_the_flagged_observations',
            },
          });
          ctx.exceptionIds.add(raised.id);
        }
        const count = (outcome: OfflineItemResult['outcome']) =>
          results.filter((r) => r.outcome === outcome).length;
        const counts = {
          accepted: count('accepted'),
          acceptedWithConflict: count('accepted_with_conflict'),
          duplicate: count('duplicate'),
          rejected: count('rejected'),
          stale: staleIds.length,
        };
        const row = await trx
          .insertInto('offline_sync_batches')
          .values({
            id: batchId,
            organization_id: organizationId,
            facility_id: facility.id,
            device_id: body.deviceId,
            client_batch_id: body.clientBatchId,
            snapshot_reference: body.snapshot.reference,
            snapshot_taken_at: snapshotTakenAt,
            received_at: receivedAt,
            snapshot_age_seconds: Math.max(
              0,
              Math.floor((receivedAt.getTime() - snapshotTakenAt.getTime()) / 1000),
            ),
            max_roster_age_minutes: policy.maxRosterAgeMinutes,
            item_count: results.length,
            accepted_count: counts.accepted,
            conflict_count: counts.acceptedWithConflict,
            duplicate_count: counts.duplicate,
            rejected_count: counts.rejected,
            stale_count: counts.stale,
            stale: counts.stale > 0,
            results: json(results),
            exception_ids: [...ctx.exceptionIds],
            request_fingerprint: fingerprint,
            operation_id: operationId,
            submitted_by: json(snapshotActor(principal)),
            submitted_by_person_id: principal.personId,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await this.operations.transition(trx, operationId, 'succeeded', {
          result: { batchId, ...counts },
        });
        await this.audit.record(trx, {
          organizationId,
          actor: principal,
          action: EntryActions.syncOffline.id,
          targetType: 'offline_sync_batch',
          targetId: batchId,
          afterRevision: 1,
          reason: body.reason ?? null,
          correlationId,
          operationId,
          details: { deviceId: body.deviceId, items: results.length, ...counts },
        });
        await this.outbox.enqueue(trx, EntryEvents.offlineBatchSynced, {
          organizationId,
          aggregateType: 'offline_sync_batch',
          aggregateId: batchId,
          payload: {
            batchId,
            facilityId: facility.id,
            deviceId: body.deviceId,
            accepted: counts.accepted,
            acceptedWithConflict: counts.acceptedWithConflict,
            duplicate: counts.duplicate,
            rejected: counts.rejected,
            stale: counts.stale > 0,
          },
          correlationId,
          operationId,
        });
        return toBatch(row, false);
      });
    } catch (error) {
      // A concurrent upload of the same batch committed first: return its stored outcome (or a
      // conflict when the winner carried different contents under the same client batch id).
      if (
        isUniqueViolation(error) &&
        pgConstraintName(error) === 'offline_sync_batches_client_unique'
      ) {
        const winner = await this.findBatch(this.uow.reader(), organizationId, body);
        if (winner) return replayOf(winner, body, fingerprint);
      }
      throw error;
    }
  }

  /**
   * §4.15 / §4.7 invariant 12 / SPK-ENTRY-007: a device queues a release (or a departure) because
   * staff saw the child leave while offline. When the server cannot record it as a verified
   * release — no approved procedure, outside the device's scope or authority, a collector who
   * cannot be identified, an impossible time, or a child departure that needed a release — the
   * item stays rejected (no authority is asserted, the visit is not closed) and a critical
   * exception asks the pickup queue to confirm where the child is. One exception per queued item
   * (device and client observation id), so re-sending the item does not open a second one.
   * Whether such a handover may later be recorded as a fact is DEC-034 / DEC-005 (pending).
   */
  private async followUpUnrecordedRelease(
    trx: Trx,
    ctx: BatchContext,
    item: OfflineItem,
    outcome: OfflineItemResult,
  ): Promise<void> {
    if (outcome.outcome !== 'rejected') return;
    let childPersonId: string;
    let details: Record<string, unknown>;
    if (item.kind === 'release') {
      childPersonId = item.childPersonId;
      details = {
        collectorPersonId: 'personId' in item.collector ? item.collector.personId : null,
        collectorDescription: 'description' in item.collector ? item.collector.description : null,
        manualProcedureReference: item.manualProcedureReference ?? null,
        activity: item.activity ?? null,
      };
    } else if (item.kind === 'departure' && outcome.reason === 'release_required') {
      childPersonId = item.personId;
      const visit = await this.visits.openVisit(
        trx,
        ctx.organizationId,
        ctx.facility.id,
        item.personId,
      );
      details = { visitId: visit?.id ?? null };
    } else {
      return;
    }
    const child = await this.people.findPerson(ctx.organizationId, childPersonId, trx);
    if (!child || child.kind !== 'child' || child.status !== 'active') return;
    await this.raiseUnrecordedRelease(trx, ctx, {
      childPersonId,
      deviceId: ctx.deviceId,
      clientObservationId: item.clientObservationId,
      batchId: ctx.batchId,
      kind: item.kind,
      observedAt: new Date(item.observedAt).toISOString(),
      reason: outcome.reason,
      details,
    });
  }

  /** The critical follow-up for one queued item (device and client observation id). */
  private async raiseUnrecordedRelease(
    trx: Trx,
    ctx: BatchContext,
    input: {
      childPersonId: string;
      deviceId: string;
      clientObservationId: string;
      batchId: string;
      kind: OfflineItem['kind'];
      observedAt: string;
      reason: string | null;
      details: Record<string, unknown>;
    },
  ): Promise<void> {
    const raised = await this.exceptions.raise(trx, {
      organizationId: ctx.organizationId,
      facilityId: ctx.facility.id,
      category: UNRECORDED_RELEASE,
      severity: 'critical',
      title:
        'A child was reported leaving while offline, but no verified release could be recorded',
      affectedType: 'person',
      affectedId: input.childPersonId,
      ownerQueue: ctx.policy.pickupEscalationQueue,
      dedupeKey: `${UNRECORDED_RELEASE}:${input.deviceId}:${input.clientObservationId}`,
      details: {
        batchId: input.batchId,
        deviceId: input.deviceId,
        clientObservationId: input.clientObservationId,
        kind: input.kind,
        childPersonId: input.childPersonId,
        observedAt: input.observedAt,
        reason: input.reason,
        ...input.details,
        nextAction: 'confirm_the_child_whereabouts_and_follow_the_pickup_procedure',
      },
    });
    ctx.exceptionIds.add(raised.id);
  }

  private async apply(trx: Trx, ctx: BatchContext, item: OfflineItem): Promise<OfflineItemResult> {
    const observedAt = new Date(item.observedAt);
    const skew = ctx.policy.clockSkewToleranceMinutes;
    if (observedAt.getTime() > addMinutes(ctx.receivedAt, skew).getTime()) {
      return result(item, 'rejected', 'observed_in_future', null);
    }
    if (observedAt.getTime() < addMinutes(ctx.snapshotTakenAt, -skew).getTime()) {
      return result(item, 'rejected', 'observed_before_snapshot', null);
    }
    const stale =
      observedAt.getTime() - ctx.snapshotTakenAt.getTime() >
      ctx.policy.maxRosterAgeMinutes * 60_000;
    switch (item.kind) {
      case 'attendance':
        return this.applyAttendance(trx, ctx, item, observedAt, stale);
      case 'arrival':
        return this.applyArrival(trx, ctx, item, observedAt, stale);
      case 'departure':
        return this.applyDeparture(trx, ctx, item, observedAt, stale);
      case 'release':
        return this.applyRelease(trx, ctx, item, observedAt, stale);
    }
  }

  private activityFor(
    ctx: BatchContext,
    item: OfflineItem,
  ): { activity: ResolvedActivity } | { rejected: string } | null {
    const ref = item.kind === 'attendance' || item.kind === 'release' ? item.activity : undefined;
    if (!ref) return null;
    const key = activityKey(ref);
    const activity = ctx.activities.get(key) ?? null;
    if (!activity) return { rejected: 'activity_not_found' };
    // §4.15 "scoped roster": the snapshot covers one facility only.
    if (activity.facilityId !== ctx.facility.id) return { rejected: 'outside_snapshot_scope' };
    if (!ctx.desk && !ctx.assigned.get(key)) return { rejected: 'not_assigned' };
    return { activity };
  }

  private async personActive(ctx: BatchContext, trx: Trx, personId: string): Promise<boolean> {
    const person = await this.people.findPerson(ctx.organizationId, personId, trx);
    return person?.status === 'active';
  }

  private async applyAttendance(
    trx: Trx,
    ctx: BatchContext,
    item: Extract<OfflineItem, { kind: 'attendance' }>,
    observedAt: Date,
    stale: boolean,
  ): Promise<OfflineItemResult> {
    const resolved = this.activityFor(ctx, item);
    if (!resolved || 'rejected' in resolved) {
      return result(item, 'rejected', resolved ? resolved.rejected : 'activity_not_found', null);
    }
    if (!(await this.personActive(ctx, trx, item.personId))) {
      return result(item, 'rejected', 'person_not_found', null);
    }
    const inserted = await this.attendance.insert(
      trx,
      ctx.principal,
      ctx.organizationId,
      {
        activity: resolved.activity,
        personId: item.personId,
        observedState: item.observedState,
        observedAt,
        source: 'offline_sync',
        deviceId: ctx.deviceId,
        clientObservationId: item.clientObservationId,
        syncBatchId: ctx.batchId,
        snapshotReference: ctx.snapshotReference,
        snapshotTakenAt: ctx.snapshotTakenAt,
        flags: stale ? ['stale_snapshot'] : [],
      },
      ctx.correlationId,
      null,
    );
    if (inserted.duplicate) {
      return result(item, 'duplicate', 'already_recorded', inserted.row.id, inserted.row.flags);
    }
    if (inserted.conflict) {
      ctx.exceptionIds.add(inserted.conflict.exceptionId);
      return result(
        item,
        'accepted_with_conflict',
        'conflicting_observation',
        inserted.row.id,
        inserted.row.flags,
      );
    }
    return result(item, 'accepted', null, inserted.row.id, inserted.row.flags);
  }

  private async applyArrival(
    trx: Trx,
    ctx: BatchContext,
    item: Extract<OfflineItem, { kind: 'arrival' }>,
    observedAt: Date,
    stale: boolean,
  ): Promise<OfflineItemResult> {
    const flags = stale ? ['stale_snapshot'] : [];
    const previous = await this.byClientId(trx, 'visits', ctx, item.clientObservationId);
    if (previous) return result(item, 'duplicate', 'already_recorded', previous);
    if (!ctx.desk) return result(item, 'rejected', 'not_permitted', null);
    if (!(await this.personActive(ctx, trx, item.personId))) {
      return result(item, 'rejected', 'person_not_found', null);
    }
    const open = await this.visits.openVisit(
      trx,
      ctx.organizationId,
      ctx.facility.id,
      item.personId,
    );
    if (open) return result(item, 'duplicate', 'already_on_site', open.id);
    const row = await this.visits.insertVisit(trx, ctx.principal, ctx.organizationId, {
      facilityId: ctx.facility.id,
      personId: item.personId,
      visitorCategory: item.visitorCategory,
      arrivedAt: observedAt,
      source: 'offline_sync',
      deviceId: ctx.deviceId,
      clientObservationId: item.clientObservationId,
      syncBatchId: ctx.batchId,
    });
    if (!row) {
      const raced = await this.byClientId(trx, 'visits', ctx, item.clientObservationId);
      return result(item, 'duplicate', raced ? 'already_recorded' : 'already_on_site', raced);
    }
    await this.visits.afterVisit(trx, ctx.principal, ctx.organizationId, row, ctx.correlationId);
    const closedBy = await this.closeFromEarlierSync(trx, ctx, row, observedAt);
    return result(item, 'accepted', null, row.id, closedBy ? [...flags, closedBy] : flags);
  }

  /**
   * §4.15 / SPK-AT-018 reordered uploads: an arrival synchronized after the release or departure
   * that ended it (an exit tablet reconnecting before the entrance tablet) closes the new visit
   * from that record instead of leaving the person on site:
   *   (a) a release of this child at this facility, released at or after the arrival while no
   *       visit was open, that no departure names yet — the visit departs through the release;
   *   (b) otherwise the earliest departure held for review (`entry.offline_departure_unmatched`)
   *       for this person, observed at or after the arrival and not recorded since — the visit
   *       departs at the observed time, attributed to the original device, item and batch. A
   *       child who must leave through a release is never closed this way: the visit stays open
   *       and a critical `entry.offline_release_unrecorded` asks the pickup queue to confirm
   *       where the child is (SPK-ENTRY-007, §4.7 invariant 12).
   * The review exception stays open for staff to close.
   */
  private async closeFromEarlierSync(
    trx: Trx,
    ctx: BatchContext,
    visit: VisitRow,
    observedAt: Date,
  ): Promise<string | null> {
    const personId = visit.person_id;
    if (!personId) return null;
    const release = await trx
      .selectFrom('release_records as r')
      .select(['r.id', 'r.released_at'])
      .where('r.organization_id', '=', ctx.organizationId)
      .where('r.facility_id', '=', ctx.facility.id)
      .where('r.child_person_id', '=', personId)
      .where('r.outcome', '=', 'released')
      .where('r.released_at', '>=', observedAt)
      // Recorded while the child had no open visit: the arrival it ends had not synchronized.
      .where('r.visit_id', 'is', null)
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom('departures as d')
              .select('d.id')
              .whereRef('d.organization_id', '=', 'r.organization_id')
              .whereRef('d.release_record_id', '=', 'r.id'),
          ),
        ),
      )
      .orderBy('r.released_at')
      .orderBy('r.id')
      .executeTakeFirst();
    if (release?.released_at) {
      await this.visits.recordDeparture(
        trx,
        ctx.principal,
        ctx.organizationId,
        {
          visit,
          departedAt: new Date(release.released_at),
          source: 'release',
          releaseRecordId: release.id,
        },
        ctx.correlationId,
      );
      return 'closed_by_earlier_synced_release';
    }
    const held = await trx
      .selectFrom('operational_exceptions')
      .select(['id', 'details'])
      .where('organization_id', '=', ctx.organizationId)
      .where('facility_id', '=', ctx.facility.id)
      .where('category', '=', UNMATCHED_DEPARTURE)
      .where('status', 'in', ['open', 'acknowledged'])
      .where(sql<string>`details->>'personId'`, '=', personId)
      .execute();
    const candidates = held
      .map((row) => row.details as Partial<UnmatchedDepartureDetails>)
      .filter(
        (d): d is UnmatchedDepartureDetails =>
          d.personId === personId &&
          typeof d.observedAt === 'string' &&
          typeof d.deviceId === 'string' &&
          typeof d.clientObservationId === 'string' &&
          typeof d.batchId === 'string' &&
          new Date(d.observedAt).getTime() >= observedAt.getTime(),
      )
      .sort(
        (a, b) =>
          new Date(a.observedAt).getTime() - new Date(b.observedAt).getTime() ||
          (a.clientObservationId < b.clientObservationId ? -1 : 1),
      );
    if (candidates.length === 0) return null;
    const releaseRequired = await this.visits.releaseRequired(
      trx,
      ctx.organizationId,
      visit,
      ctx.policy,
    );
    for (const pending of candidates) {
      const recorded = await trx
        .selectFrom('departures')
        .select('id')
        .where('organization_id', '=', ctx.organizationId)
        .where('device_id', '=', pending.deviceId)
        .where('client_observation_id', '=', pending.clientObservationId)
        .executeTakeFirst();
      if (recorded) continue;
      if (releaseRequired) {
        // SPK-ENTRY-007 / §4.7 invariant 12: the child was seen leaving without a release; the
        // visit stays open and the pickup queue is asked to confirm where the child is.
        await this.raiseUnrecordedRelease(trx, ctx, {
          childPersonId: personId,
          deviceId: pending.deviceId,
          clientObservationId: pending.clientObservationId,
          batchId: pending.batchId,
          kind: 'departure',
          observedAt: pending.observedAt,
          reason: 'release_required',
          details: { visitId: visit.id },
        });
        return null;
      }
      await this.visits.recordDeparture(
        trx,
        ctx.principal,
        ctx.organizationId,
        {
          visit,
          departedAt: new Date(pending.observedAt),
          source: 'offline_sync',
          deviceId: pending.deviceId,
          clientObservationId: pending.clientObservationId,
          syncBatchId: pending.batchId,
        },
        ctx.correlationId,
      );
      return 'closed_by_earlier_synced_departure';
    }
    return null;
  }

  private async applyDeparture(
    trx: Trx,
    ctx: BatchContext,
    item: Extract<OfflineItem, { kind: 'departure' }>,
    observedAt: Date,
    stale: boolean,
  ): Promise<OfflineItemResult> {
    const previous = await this.byClientId(trx, 'departures', ctx, item.clientObservationId);
    if (previous) return result(item, 'duplicate', 'already_recorded', previous);
    if (!ctx.desk) return result(item, 'rejected', 'not_permitted', null);
    const visit = await this.visits.openVisit(
      trx,
      ctx.organizationId,
      ctx.facility.id,
      item.personId,
    );
    if (!visit) {
      // §4.15 / SPK-AT-018: the arrival it closes may not have synchronized yet (another device,
      // or a later batch). The departure is kept for review — and closes the visit when that
      // arrival arrives (closeFromEarlierSync) — instead of being dropped.
      if (await this.personActive(ctx, trx, item.personId)) {
        const raised = await this.exceptions.raise(trx, {
          organizationId: ctx.organizationId,
          facilityId: ctx.facility.id,
          category: UNMATCHED_DEPARTURE,
          severity: 'warning',
          title: 'An offline departure was synchronized while the person had no open visit',
          affectedType: 'offline_sync_batch',
          affectedId: ctx.batchId,
          ownerQueue: ctx.policy.attendanceReviewQueue,
          dedupeKey: `${UNMATCHED_DEPARTURE}:${ctx.deviceId}:${item.clientObservationId}`,
          details: {
            facilityId: ctx.facility.id,
            personId: item.personId,
            observedAt: observedAt.toISOString(),
            deviceId: ctx.deviceId,
            clientObservationId: item.clientObservationId,
            batchId: ctx.batchId,
            nextAction: 'record_the_departure_or_void_the_visit',
          } satisfies UnmatchedDepartureDetails & Record<string, unknown>,
        });
        ctx.exceptionIds.add(raised.id);
      }
      return result(item, 'rejected', 'no_open_visit', null);
    }
    if (await this.visits.releaseRequired(trx, ctx.organizationId, visit, ctx.policy)) {
      return result(item, 'rejected', 'release_required', null);
    }
    const departure = await this.visits.recordDeparture(
      trx,
      ctx.principal,
      ctx.organizationId,
      {
        visit,
        departedAt: observedAt,
        source: 'offline_sync',
        deviceId: ctx.deviceId,
        clientObservationId: item.clientObservationId,
        syncBatchId: ctx.batchId,
      },
      ctx.correlationId,
    );
    return result(item, 'accepted', null, departure.id, stale ? ['stale_snapshot'] : []);
  }

  private async applyRelease(
    trx: Trx,
    ctx: BatchContext,
    item: Extract<OfflineItem, { kind: 'release' }>,
    observedAt: Date,
    stale: boolean,
  ): Promise<OfflineItemResult> {
    const previous = await this.byClientId(trx, 'release_records', ctx, item.clientObservationId);
    if (previous) return result(item, 'duplicate', 'already_recorded', previous);
    // §4.15: current pickup permission is never authorized offline. Only a separately approved
    // manual outage procedure may have released the child (DEC-005, DEC-034).
    if (
      !item.manualProcedureReference ||
      !ctx.policy.approvedOutageProcedures.includes(item.manualProcedureReference)
    ) {
      return result(item, 'rejected', 'release_requires_online_check', null);
    }
    const resolved = this.activityFor(ctx, item);
    if (resolved && 'rejected' in resolved)
      return result(item, 'rejected', resolved.rejected, null);
    // §4.11 / SPK-ENTRY-007: the same authority as POST /v1/releases — a pickup desk role, or a
    // coach assigned to the activity (an official, or a desk role without record_release, cannot).
    if (!ctx.releaseDesk) {
      if (!item.activity || !resolved || !ctx.releaseAssigned.get(activityKey(item.activity))) {
        return result(item, 'rejected', 'not_permitted', null);
      }
      // §4.14: an assigned coach releases only a child taking part in their activity; checked
      // before anything is evaluated about the child or the collector.
      if (
        !(await this.releases.takesPart(
          trx,
          ctx.organizationId,
          item.childPersonId,
          resolved.activity,
        ))
      ) {
        return result(item, 'rejected', 'not_in_activity', null);
      }
    }
    try {
      await this.releases.requireChild(trx, ctx.organizationId, item.childPersonId);
    } catch (error) {
      if (DomainError.is(error)) {
        return result(
          item,
          'rejected',
          error.code === 'NOT_FOUND' ? 'person_not_found' : 'not_a_child',
          null,
        );
      }
      throw error;
    }
    const collectorPersonId = 'personId' in item.collector ? item.collector.personId : null;
    if (collectorPersonId && !(await this.personActive(ctx, trx, collectorPersonId))) {
      return result(item, 'rejected', 'person_not_found', null);
    }
    // The online re-check at synchronization (SPK-AT-018: stale authority is not asserted).
    // `collect` must be held now AND at the recorded handover time: a grant that began, or a
    // restriction that ended, after the child left does not make the release authorized.
    const permissions = await this.releases.currentPermissions(
      trx,
      ctx.organizationId,
      collectorPersonId,
      item.childPersonId,
    );
    const heldNow = collectorPersonId !== null && permissions.includes('collect');
    const heldAtRelease =
      heldNow &&
      collectorPersonId !== null &&
      (await this.releases.heldAt(
        trx,
        ctx.organizationId,
        collectorPersonId,
        item.childPersonId,
        observedAt,
      ));
    const held = heldNow && heldAtRelease;
    const releaseId = newId();
    let exceptionId: string | null = null;
    if (!held) {
      exceptionId = await this.releases.raise(
        trx,
        ctx.organizationId,
        ctx.facility.id,
        releaseId,
        ctx.policy,
        {
          category: 'entry.offline_release_unverified',
          severity: 'critical',
          title: 'A child was released offline to someone without current pickup authority',
        },
      );
      ctx.exceptionIds.add(exceptionId);
    }
    const { release } = await this.releases.persist(
      trx,
      ctx.principal,
      ctx.organizationId,
      releaseId,
      {
        facilityId: ctx.facility.id,
        childPersonId: item.childPersonId,
        collectorPersonId,
        collectorDescription: 'description' in item.collector ? item.collector.description : null,
        activity: resolved?.activity ?? null,
        verificationMethod: 'manual_outage_procedure',
        verificationOutcome: 'manual_outage_procedure',
        collectorPermissions: permissions,
        authorityCheckedAt: ctx.receivedAt,
        denialReason: held
          ? null
          : heldNow
            ? 'The collecting person did not hold pickup (collect) permission at the recorded release time; it was granted, or a restriction ended, afterwards.'
            : denialReasonFor(collectorPersonId, permissions),
        restrictionNotes: null,
        escalationNotes: null,
        escalationExceptionId: exceptionId,
        manualProcedureReference: item.manualProcedureReference,
        postSyncAuthority: held ? 'held' : 'not_held',
        outcome: 'released',
        decidedAt: observedAt,
        source: 'offline_sync',
        deviceId: ctx.deviceId,
        clientObservationId: item.clientObservationId,
        syncBatchId: ctx.batchId,
        recordDeparture: true,
      },
      ctx.correlationId,
      null,
    );
    const flags = stale ? ['stale_snapshot'] : [];
    return held
      ? result(item, 'accepted', null, release.id, flags)
      : result(
          item,
          'accepted_with_conflict',
          heldNow ? 'authority_not_held_at_release' : 'authority_not_held_at_sync',
          release.id,
          flags,
        );
  }

  private async byClientId(
    trx: Trx,
    table: 'visits' | 'departures' | 'release_records',
    ctx: BatchContext,
    clientObservationId: string,
  ): Promise<string | null> {
    const row = await trx
      .selectFrom(table)
      .select('id')
      .where('organization_id', '=', ctx.organizationId)
      .where('device_id', '=', ctx.deviceId)
      .where('client_observation_id', '=', clientObservationId)
      .executeTakeFirst();
    return row?.id ?? null;
  }

  private async findBatch(
    db: Db | Trx,
    organizationId: string,
    body: Pick<OfflineSyncBody, 'deviceId' | 'clientBatchId'>,
  ): Promise<BatchRow | undefined> {
    return db
      .selectFrom('offline_sync_batches')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('device_id', '=', body.deviceId)
      .where('client_batch_id', '=', body.clientBatchId)
      .executeTakeFirst();
  }
}

/**
 * The request fingerprint of a batch (§4.9 "the same key with different contents returns a
 * conflict", applied to the client batch id): facility, snapshot and every item, items in client
 * observation id order and times normalized, so a faithful re-send matches and anything else
 * does not. Command metadata (reason, policy references) is not part of the observations.
 */
function requestFingerprint(body: OfflineSyncBody): string {
  return canonicalHash({
    facilityId: body.facilityId,
    snapshot: {
      reference: body.snapshot.reference,
      takenAt: new Date(body.snapshot.takenAt).toISOString(),
    },
    items: [...body.items]
      .map((item) => ({ ...item, observedAt: new Date(item.observedAt).toISOString() }))
      .sort((a, b) =>
        a.clientObservationId < b.clientObservationId
          ? -1
          : a.clientObservationId > b.clientObservationId
            ? 1
            : 0,
      ),
  });
}

/**
 * The stored outcome of a re-uploaded batch, or a conflict when the client batch id was used for
 * a different upload (other items, snapshot or facility). The conflict carries nothing about the
 * stored batch: a principal of another facility learns neither its records nor its counts (§4.14).
 * Batches stored before the fingerprint existed compare facility, snapshot and item ids.
 */
function replayOf(stored: BatchRow, body: OfflineSyncBody, fingerprint: string): OfflineSyncBatch {
  const reused = () =>
    errors.resourceConflict(
      'This client batch id was already used for a different upload; send these items under a new client batch id.',
      { code: 'batch_id_reused', clientBatchId: body.clientBatchId },
    );
  if (stored.facility_id !== body.facilityId) throw reused();
  if (stored.request_fingerprint !== null) {
    if (stored.request_fingerprint !== fingerprint) throw reused();
    return toBatch(stored, true);
  }
  const storedItems = (stored.results as OfflineItemResult[])
    .map((r) => `${r.kind}:${r.clientObservationId}`)
    .sort();
  const requestItems = body.items.map((i) => `${i.kind}:${i.clientObservationId}`).sort();
  if (
    stored.snapshot_reference !== body.snapshot.reference ||
    new Date(stored.snapshot_taken_at).getTime() !== new Date(body.snapshot.takenAt).getTime() ||
    storedItems.join(',') !== requestItems.join(',')
  ) {
    throw reused();
  }
  return toBatch(stored, true);
}

/** The advisory lock keys a batch needs (attendance per activity and person; presence per person). */
function subjectLockKeys(
  organizationId: string,
  items: readonly OfflineItem[],
  activities: Map<string, ResolvedActivity | null>,
): string[] {
  return items.flatMap((item) => {
    switch (item.kind) {
      case 'attendance': {
        const activity = activities.get(activityKey(item.activity));
        return activity
          ? [
              attendanceLockKey(
                organizationId,
                activity.detail.type,
                activity.detail.id,
                item.personId,
              ),
            ]
          : [];
      }
      case 'arrival':
      case 'departure':
        return [presenceLockKey(organizationId, item.personId)];
      case 'release':
        return [presenceLockKey(organizationId, item.childPersonId)];
    }
  });
}
