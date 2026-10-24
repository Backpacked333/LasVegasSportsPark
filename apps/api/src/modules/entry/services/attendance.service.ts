import { Inject, Injectable } from '@nestjs/common';
import {
  errors,
  newId,
  type ActivityAttendance,
  type AttendanceQuery,
  type CorrectAttendanceObservationBody,
  type ObservedState,
  type PersonAttendance,
  type Principal,
  type RecordAttendanceObservationBody,
  type RecordedObservation,
} from '@sportspark/contracts';
import { isUniqueViolation, json, type Db, type ObservationFlag } from '@sportspark/db';
import {
  AuditWriter,
  AuthorizationService,
  CLOCK,
  OperationalExceptions,
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
import type { AttendancePort, EffectiveAttendance } from '../entry.ports';
import {
  activityDetailOf,
  addMinutes,
  contradictedHeads,
  currentHeads,
  effectiveState,
  headsConflict,
  observationLike,
  organizationOf,
  toObservation,
  type ObservationRow,
} from '../entry.shared';
import { ActivityResolver, refOf, type ResolvedActivity } from './activity-resolver';
import { StaffScope } from './staff-scope';

export interface NewObservation {
  activity: ResolvedActivity;
  personId: string;
  observedState: ObservedState;
  observedAt: Date;
  source: 'online' | 'offline_sync';
  deviceId?: string | null;
  clientObservationId?: string | null;
  syncBatchId?: string | null;
  snapshotReference?: string | null;
  snapshotTakenAt?: Date | null;
  flags?: ObservationFlag[];
  correctsObservationId?: string | null;
  correctionReason?: string | null;
}

export interface InsertedObservation {
  row: ObservationRow;
  duplicate: boolean;
  conflict: { exceptionId: string; conflictingObservationIds: string[] } | null;
}

/**
 * Attendance observations (§4.4, §4.5, §4.8 POST /v1/attendance-observations, SPK-ENTRY-005).
 * Observations are append-only facts about one person in one activity, recorded by desk staff or
 * by the coach or official assigned to that activity. A correction is a new observation naming
 * the one it corrects, with the actor, time and reason; the original is never edited. When
 * independent observations disagree (one says present, another absent) both are kept, flagged
 * `conflict`, and an operational exception asks the attendance review queue to resolve it with a
 * correction (§4.15 "Reconnection must preserve conflicting observations for review").
 */
@Injectable()
export class AttendanceService implements AttendancePort {
  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ENTRY_POLICY) private readonly policy: EntryPolicy,
    @Inject(PERSON_DIRECTORY_PORT) private readonly people: PersonDirectoryPort,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly exceptions: OperationalExceptions,
    private readonly resolver: ActivityResolver,
    private readonly scope: StaffScope,
  ) {}

  async record(
    principal: Principal,
    body: RecordAttendanceObservationBody,
    correlationId: string | null,
  ): Promise<RecordedObservation> {
    const organizationId = organizationOf(principal);
    const activity = await this.resolver.resolve(organizationId, body.activity);
    await this.scope.requireForActivity(
      principal,
      EntryActions.recordAttendance,
      EntryActions.recordAssignedAttendance,
      activity,
    );
    const now = this.clock.now();
    const policy = policyForFacility(this.policy, activity.facilitySettings);
    const observedAt = body.observedAt ? new Date(body.observedAt) : now;
    if (observedAt.getTime() > addMinutes(now, policy.clockSkewToleranceMinutes).getTime()) {
      throw errors.validation('An observation cannot be recorded for a future time.', {
        code: 'observed_in_future',
      });
    }
    return this.uow.run(async ({ trx }) => {
      const person = await this.people.findPerson(organizationId, body.personId, trx);
      if (!person || person.status !== 'active') throw errors.notFound('person', body.personId);
      const inserted = await this.insert(
        trx,
        principal,
        organizationId,
        {
          activity,
          personId: body.personId,
          observedState: body.observedState,
          observedAt,
          source: 'online',
          deviceId: body.deviceId ?? null,
          clientObservationId: body.clientObservationId ?? null,
        },
        correlationId,
        body.reason ?? null,
      );
      return {
        observation: toObservation(inserted.row),
        duplicate: inserted.duplicate,
        conflict: inserted.conflict,
      };
    });
  }

  async correct(
    principal: Principal,
    id: string,
    body: CorrectAttendanceObservationBody,
    correlationId: string | null,
  ): Promise<RecordedObservation> {
    const organizationId = organizationOf(principal);
    const original = await this.load(this.uow.reader(), organizationId, id);
    if (!original) throw errors.notFound('attendance_observation', id);
    const activity = await this.resolver.resolve(organizationId, refOf(activityDetailOf(original)));
    await this.scope.requireForActivity(
      principal,
      EntryActions.correctAttendance,
      EntryActions.correctAssignedAttendance,
      activity,
    );
    return this.uow.run(async ({ trx }) => {
      const correction = await trx
        .selectFrom('attendance_observations')
        .select('id')
        .where('organization_id', '=', organizationId)
        .where('corrects_observation_id', '=', id)
        .executeTakeFirst();
      if (correction) {
        throw errors.resourceConflict(
          'This observation was already corrected; correct the latest observation instead.',
          { code: 'already_corrected', correctedByObservationId: correction.id },
        );
      }
      const inserted = await this.insert(
        trx,
        principal,
        organizationId,
        {
          activity,
          personId: original.person_id,
          observedState: body.observedState,
          // The corrected state applies to the moment originally observed; the correction's own
          // time is its received time (SPK-ENTRY-005: actor, time and reason are preserved).
          observedAt: new Date(original.observed_at),
          source: 'online',
          correctsObservationId: id,
          correctionReason: body.reason,
        },
        correlationId,
        body.reason,
      ).catch((error: unknown) => {
        if (isUniqueViolation(error)) {
          throw errors.resourceConflict('This observation was already corrected.', {
            code: 'already_corrected',
          });
        }
        throw error;
      });
      return {
        observation: toObservation(inserted.row),
        duplicate: false,
        conflict: inserted.conflict,
      };
    });
  }

  async attendance(principal: Principal, query: AttendanceQuery): Promise<ActivityAttendance> {
    const organizationId = organizationOf(principal);
    const ref =
      query.activityType === 'session'
        ? query.offeringId
          ? { type: 'session' as const, offeringId: query.offeringId, sessionId: query.activityId }
          : null
        : { type: 'event' as const, eventId: query.activityId };
    if (!ref) throw errors.validation('offeringId is required for a session activity.');
    const activity = await this.resolver.resolve(organizationId, ref);
    let personFilter = query.personId ?? null;
    const target = {
      type: 'activity',
      id: activity.detail.id,
      organizationId,
      facilityId: activity.facilityId,
    };
    // Staff readers see the whole activity (no subject persons in the target, so only a staff role
    // can satisfy it); the assigned coach or official too; anyone else one person they may view.
    const staff = await this.authorization.decide(principal, EntryActions.readAttendance, target);
    if (!staff.allowed) {
      const field = await this.authorization.decide(
        principal,
        EntryActions.readAssignedAttendance,
        target,
      );
      const assigned =
        field.allowed &&
        principal.personId !== null &&
        (await this.scope.isAssigned(organizationId, activity, principal.personId));
      if (!assigned) {
        // A customer reads one person's attendance with `view` over them; nothing else (§4.10).
        if (!query.personId) throw errors.protectedNotFound('attendance');
        await this.authorization.require(principal, EntryActions.readAttendance, {
          ...target,
          type: 'attendance',
          subjectPersonIds: [query.personId],
          protected: true,
        });
        personFilter = query.personId;
      }
    }
    let q = this.uow
      .reader()
      .selectFrom('attendance_observations')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('activity_type', '=', activity.detail.type)
      .where('activity_id', '=', activity.detail.id)
      .orderBy('person_id')
      .orderBy('received_at')
      .orderBy('id');
    if (personFilter) q = q.where('person_id', '=', personFilter);
    const rows = await q.execute();
    const byPerson = new Map<string, ObservationRow[]>();
    for (const row of rows) {
      const list = byPerson.get(row.person_id) ?? [];
      list.push(row);
      byPerson.set(row.person_id, list);
    }
    const people: PersonAttendance[] = [...byPerson.entries()].map(([personId, list]) =>
      summarize(personId, list),
    );
    return { activity: activity.detail, people };
  }

  // -------------------------------------------------------------------------------------------
  // AttendancePort
  // -------------------------------------------------------------------------------------------

  async effectiveAttendance(
    organizationId: string,
    activityType: 'session' | 'event',
    activityId: string,
    trx?: Trx,
  ): Promise<EffectiveAttendance[]> {
    const rows = await (trx ?? this.uow.reader())
      .selectFrom('attendance_observations')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('activity_type', '=', activityType)
      .where('activity_id', '=', activityId)
      .orderBy('person_id')
      .execute();
    const byPerson = new Map<string, ObservationRow[]>();
    for (const row of rows)
      byPerson.set(row.person_id, [...(byPerson.get(row.person_id) ?? []), row]);
    return [...byPerson.entries()].map(([personId, list]) => {
      const heads = currentHeads(list.map(observationLike));
      return { personId, state: effectiveState(heads), conflict: headsConflict(heads) };
    });
  }

  async openVisitOf(
    organizationId: string,
    facilityId: string,
    personId: string,
    trx?: Trx,
  ): Promise<{ visitId: string; arrivedAt: Date } | null> {
    const row = await (trx ?? this.uow.reader())
      .selectFrom('visits')
      .select(['id', 'arrived_at'])
      .where('organization_id', '=', organizationId)
      .where('facility_id', '=', facilityId)
      .where('person_id', '=', personId)
      .where('status', '=', 'on_site')
      .executeTakeFirst();
    return row ? { visitId: row.id, arrivedAt: new Date(row.arrived_at) } : null;
  }

  // -------------------------------------------------------------------------------------------
  // Shared with offline synchronization
  // -------------------------------------------------------------------------------------------

  /**
   * Inserts one observation. A repeated client observation id (same device) inserts nothing and
   * returns the stored row (idempotent synchronization). A contradiction with the current heads is
   * flagged and raised for review; both observations stay.
   */
  async insert(
    trx: Trx,
    principal: Principal,
    organizationId: string,
    input: NewObservation,
    correlationId: string | null,
    reason: string | null,
  ): Promise<InsertedObservation> {
    if (input.clientObservationId && input.deviceId) {
      const existing = await this.byClientId(
        trx,
        organizationId,
        input.deviceId,
        input.clientObservationId,
      );
      if (existing) return { row: existing, duplicate: true, conflict: null };
    }
    const prior = await trx
      .selectFrom('attendance_observations')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('activity_type', '=', input.activity.detail.type)
      .where('activity_id', '=', input.activity.detail.id)
      .where('person_id', '=', input.personId)
      .execute();
    const contradicted = contradictedHeads(
      prior.map(observationLike),
      input.observedState,
      input.correctsObservationId ?? null,
    );
    const flags = new Set<ObservationFlag>(input.flags ?? []);
    if (contradicted.length > 0) flags.add('conflict');
    const activity = input.activity;
    const row = await trx
      .insertInto('attendance_observations')
      .values({
        id: newId(),
        organization_id: organizationId,
        facility_id: activity.facilityId,
        person_id: input.personId,
        activity_type: activity.detail.type,
        activity_id: activity.detail.id,
        offering_id: activity.offeringId,
        offering_session_id: activity.detail.type === 'session' ? activity.detail.id : null,
        scheduling_event_id: activity.schedulingEventId,
        observed_state: input.observedState,
        observed_at: input.observedAt,
        received_at: this.clock.now(),
        source: input.source,
        device_id: input.deviceId ?? null,
        client_observation_id: input.clientObservationId ?? null,
        sync_batch_id: input.syncBatchId ?? null,
        snapshot_reference: input.snapshotReference ?? null,
        snapshot_taken_at: input.snapshotTakenAt ?? null,
        flags: [...flags],
        corrects_observation_id: input.correctsObservationId ?? null,
        correction_reason: input.correctionReason ?? null,
        recorded_by: json(snapshotActor(principal)),
        recorded_by_person_id: principal.personId,
      })
      .onConflict((oc) =>
        oc
          .columns(['organization_id', 'device_id', 'client_observation_id'])
          .where('client_observation_id', 'is not', null)
          .doNothing(),
      )
      .returningAll()
      .executeTakeFirst();
    if (!row) {
      // A concurrent upload of the same client observation committed first.
      const existing = await this.byClientId(
        trx,
        organizationId,
        input.deviceId ?? '',
        input.clientObservationId ?? '',
      );
      if (!existing) throw errors.internal('observation insert conflicted without a stored row');
      return { row: existing, duplicate: true, conflict: null };
    }
    let conflict: InsertedObservation['conflict'] = null;
    if (contradicted.length > 0) {
      const policy = policyForFacility(this.policy, activity.facilitySettings);
      const ids = [...contradicted.map((c) => c.id), row.id];
      const raised = await this.exceptions.raise(trx, {
        organizationId,
        facilityId: activity.facilityId,
        category: 'entry.attendance_conflict',
        severity: 'warning',
        title: 'Conflicting attendance observations need review',
        affectedType: 'attendance',
        affectedId: `${activity.detail.type}:${activity.detail.id}:${input.personId}`,
        ownerQueue: policy.attendanceReviewQueue,
        dedupeKey: `entry.attendance_conflict:${activity.detail.id}:${input.personId}`,
        details: {
          activityType: activity.detail.type,
          activityId: activity.detail.id,
          personId: input.personId,
          observationIds: ids,
          nextAction: 'record_a_correction_naming_the_effective_state',
        },
      });
      conflict = { exceptionId: raised.id, conflictingObservationIds: ids };
    }
    await this.audit.record(trx, {
      organizationId,
      actor: principal,
      action: input.correctsObservationId
        ? EntryActions.correctAttendance.id
        : EntryActions.recordAttendance.id,
      targetType: 'attendance_observation',
      targetId: row.id,
      afterRevision: 1,
      reason,
      correlationId,
      details: {
        observedState: row.observed_state,
        source: row.source,
        correctsObservationId: row.corrects_observation_id,
        flags: row.flags,
      },
    });
    await this.outbox.enqueue(trx, EntryEvents.attendanceObserved, {
      organizationId,
      aggregateType: 'attendance_observation',
      aggregateId: row.id,
      payload: {
        observationId: row.id,
        facilityId: row.facility_id,
        personId: row.person_id,
        activityType: row.activity_type,
        activityId: row.activity_id,
        observedState: row.observed_state,
        correctsObservationId: row.corrects_observation_id,
        source: row.source,
        flags: [...row.flags],
      },
      correlationId,
    });
    return { row, duplicate: false, conflict };
  }

  async byClientId(
    db: Db | Trx,
    organizationId: string,
    deviceId: string,
    clientObservationId: string,
  ): Promise<ObservationRow | undefined> {
    return db
      .selectFrom('attendance_observations')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('device_id', '=', deviceId)
      .where('client_observation_id', '=', clientObservationId)
      .executeTakeFirst();
  }

  private async load(db: Db | Trx, organizationId: string, id: string) {
    return db
      .selectFrom('attendance_observations')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', id)
      .executeTakeFirst();
  }
}

/** One person's attendance in an activity: the current heads and the full, uncut history. */
export function summarize(personId: string, rows: readonly ObservationRow[]): PersonAttendance {
  const likes = rows.map(observationLike);
  const heads = currentHeads(likes);
  const correctedBy = new Map<string, string>();
  for (const row of rows) {
    if (row.corrects_observation_id) correctedBy.set(row.corrects_observation_id, row.id);
  }
  const conflict = headsConflict(heads);
  return {
    personId,
    effectiveState: effectiveState(heads),
    status: conflict ? 'conflict' : 'recorded',
    currentObservationIds: heads.map((h) => h.id),
    history: rows.map((row) => ({
      ...toObservation(row),
      correctedByObservationId: correctedBy.get(row.id) ?? null,
    })),
  };
}
