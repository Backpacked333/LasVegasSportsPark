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
import {
  AuditWriter,
  AuthorizationService,
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
import { addMinutes, organizationOf, toBatch, type BatchRow } from '../entry.shared';
import {
  activityKey,
  ActivityResolver,
  type FacilityFacts,
  type ResolvedActivity,
} from './activity-resolver';
import { AttendanceService } from './attendance.service';
import { denialReasonFor, ReleasesService } from './releases.service';
import { StaffScope } from './staff-scope';
import { VisitsService } from './visits.service';

interface BatchContext {
  principal: Principal;
  organizationId: string;
  facility: FacilityFacts;
  policy: EntryPolicy;
  desk: boolean;
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
 *   - a re-uploaded batch (same device and client batch id) returns the stored outcome;
 *   - an item already recorded (same device and client observation id) is a `duplicate`;
 *   - an item observed against a roster older than the maximum roster age (DEC-033, proposed two
 *     hours) is accepted but flagged `stale_snapshot`, and the batch is raised for review;
 *   - a conflicting observation is kept and raised for review (`accepted_with_conflict`);
 *   - a queued release is REJECTED unless it names a separately approved manual outage procedure
 *     (DEC-005, DEC-034; none approved by default). Even then current authority is re-checked
 *     online now, and a release made without it raises a critical exception — stale authority is
 *     never asserted.
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
    const stored = await this.findBatch(this.uow.reader(), organizationId, body);
    if (stored) return toBatch(stored, true);

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
    try {
      return await this.uow.run(async ({ trx }) => {
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
        for (const item of body.items) results.push(await this.apply(trx, ctx, item));

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
      // A concurrent upload of the same batch committed first: return its stored outcome.
      if (
        isUniqueViolation(error) &&
        pgConstraintName(error) === 'offline_sync_batches_client_unique'
      ) {
        const winner = await this.findBatch(this.uow.reader(), organizationId, body);
        if (winner) return toBatch(winner, true);
      }
      throw error;
    }
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
    return result(item, 'accepted', null, row.id, flags);
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
    if (!visit) return result(item, 'rejected', 'no_open_visit', null);
    if (
      visit.visitor_category === 'participant' &&
      ctx.policy.childParticipantDepartureRequiresRelease
    ) {
      const person = await this.people.findPerson(ctx.organizationId, item.personId, trx);
      if (person?.kind === 'child') return result(item, 'rejected', 'release_required', null);
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
    if (!ctx.desk && !resolved) return result(item, 'rejected', 'not_permitted', null);
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
    const permissions = await this.releases.currentPermissions(
      trx,
      ctx.organizationId,
      collectorPersonId,
      item.childPersonId,
    );
    const held = collectorPersonId !== null && permissions.includes('collect');
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
        denialReason: held ? null : denialReasonFor(collectorPersonId, permissions),
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
      : result(item, 'accepted_with_conflict', 'authority_not_held_at_sync', release.id, flags);
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
