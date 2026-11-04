import { Inject, Injectable } from '@nestjs/common';
import {
  DomainError,
  errors,
  newId,
  systemPrincipal,
  type CreateSessionCheckinBody,
  type Principal,
  type RecheckSessionCheckinBody,
  type SessionCheckin,
  type WithdrawSessionCheckinBody,
} from '@sportspark/contracts';
import { isUniqueViolation, json, type Db, type SessionCheckinStatus } from '@sportspark/db';
import {
  assertExpectedRevision,
  AuditWriter,
  AuthorizationService,
  CLOCK,
  ensureUpdated,
  Outbox,
  snapshotActor,
  UnitOfWork,
  type Clock,
  type Trx,
} from '../../../kernel';
import { SessionsService } from '../../catalog';
import { PERSON_DIRECTORY_PORT, type PersonDirectoryPort } from '../../identity';
import { EventsService, localDateOf } from '../../scheduling';
import { EntryActions } from '../entry.actions';
import { EntryEvents } from '../entry.events';
import { ENTRY_POLICY, policyForFacility, type EntryPolicy } from '../entry.policy';
import {
  activityDateOf,
  activityDetailOf,
  audienceOf,
  beforeActivityDay,
  organizationOf,
  toCheckin,
  type CheckinAudience,
  type CheckinRow,
} from '../entry.shared';
import { SessionCheckinMachine } from '../entry.state-machines';
import { ActivityResolver, refOf, type ResolvedActivity } from './activity-resolver';
import { ArrivalChecks, hasBlocking, type ParticipationBasis } from './arrival-checks';
import { StaffScope, type ActivityAuthority } from './staff-scope';
import { lockActivity, lockEntrySubjects, presenceLockKey } from './subject-locks';
import { VisitsService } from './visits.service';

/**
 * The projection a check-in command answers with (AUTHZ-PRIVACY-01): desk authority sees the
 * check-in as staff; a coach or official acting through an accepted assignment sees it without
 * finance facts (`issuesFor`).
 */
function audienceOfAuthority(authority: ActivityAuthority): CheckinAudience {
  return authority === 'assigned' ? 'assigned' : 'staff';
}

/** The withdrawal reason of a check-in whose activity its owning module canceled (ENT-03). */
export const ACTIVITY_CANCELED = 'activity_canceled';
/** The withdrawal reason of a check-in whose activity moved to another day or facility (R4-OPS-MODULES-07). */
export const ACTIVITY_MOVED = 'activity_moved';

/** An activity's current times as its owning module holds them now (read in the caller's transaction). */
interface CurrentActivityTimes {
  start: Date;
  end: Date;
  /** The event's facility; null for a session (its offering's facility does not move). */
  facilityId: string | null;
  canceled: boolean;
}

function basisColumns(basis: ParticipationBasis | null) {
  return {
    basis_kind: basis?.kind ?? null,
    enrollment_id: basis?.kind === 'enrollment' ? basis.enrollmentId : null,
    session_booking_id: basis?.kind === 'session_booking' ? basis.bookingId : null,
    basis_reference: basis?.kind === 'roster_membership' ? basis.membershipId : null,
  };
}

/**
 * Session check-ins (SPK-ENTRY-001, SPK-ENTRY-003, SPK-ENTRY-004, SPK-ENTRY-006). Staff check the
 * selected person into the selected session or event; nothing else in the household is touched.
 * The arrival checks are recorded on the check-in as actionable issues. With a blocking issue the
 * check-in is `held` (the database refuses to admit it); once the cause is resolved a re-check
 * admits it. No enrollment is ever created here: the participation basis must already exist.
 */
@Injectable()
export class CheckinsService {
  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ENTRY_POLICY) private readonly policy: EntryPolicy,
    @Inject(PERSON_DIRECTORY_PORT) private readonly people: PersonDirectoryPort,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly resolver: ActivityResolver,
    private readonly checks: ArrivalChecks,
    private readonly scope: StaffScope,
    private readonly visits: VisitsService,
    private readonly sessions: SessionsService,
    private readonly events: EventsService,
  ) {}

  async create(
    principal: Principal,
    body: CreateSessionCheckinBody,
    correlationId: string | null,
  ): Promise<SessionCheckin> {
    const organizationId = organizationOf(principal);
    const activity = await this.resolver.resolve(organizationId, body.activity);
    const authority = await this.scope.requireForActivity(
      principal,
      EntryActions.checkIn,
      EntryActions.checkInAssigned,
      activity,
    );
    return this.uow.run(async ({ trx }) => {
      const current = await this.lockForAdmission(trx, organizationId, activity);
      this.requireActivityDay(current);
      // R4-OPS-MODULES-04: the visit this check-in links is read under the person's presence
      // lock, so a concurrent void (or departure) of that visit and this check-in serialize.
      await lockEntrySubjects(trx, [presenceLockKey(organizationId, body.personId)]);
      const person = await this.people.findPerson(organizationId, body.personId, trx);
      if (!person || person.status !== 'active') throw errors.notFound('person', body.personId);
      const visit = body.visitId
        ? await this.visits.load(trx, organizationId, body.visitId)
        : await this.visits.openVisit(trx, organizationId, activity.facilityId, body.personId);
      if (body.visitId) {
        if (
          !visit ||
          visit.person_id !== body.personId ||
          visit.facility_id !== activity.facilityId ||
          visit.status !== 'on_site'
        ) {
          throw errors.validation(
            'The visit is not an open arrival of this person at this facility.',
            {
              code: 'visit_mismatch',
            },
          );
        }
      }
      const existing = await this.live(trx, organizationId, body.personId, activity);
      if (existing) {
        throw errors.resourceConflict('This person is already checked in to this activity.', {
          code: 'already_checked_in',
          checkinId: existing.id,
        });
      }
      const facility = await this.resolver.facility(organizationId, activity.facilityId, trx);
      const policy = policyForFacility(this.policy, facility.settings);
      const evaluation = await this.checks.evaluate(
        trx,
        organizationId,
        body.personId,
        current,
        policy,
        visit !== undefined,
      );
      const status: SessionCheckinStatus = hasBlocking(evaluation.issues)
        ? SessionCheckinMachine.initial
        : SessionCheckinMachine.next(SessionCheckinMachine.initial, 'admit');
      const now = this.clock.now();
      const id = newId();
      const row = await trx
        .insertInto('session_checkins')
        .values({
          id,
          organization_id: organizationId,
          facility_id: activity.facilityId,
          visit_id: visit?.id ?? null,
          person_id: body.personId,
          activity_type: activity.detail.type,
          activity_id: activity.detail.id,
          offering_id: activity.offeringId,
          offering_session_id: activity.detail.type === 'session' ? activity.detail.id : null,
          scheduling_event_id: activity.schedulingEventId,
          activity_start: current.start,
          activity_end: current.end,
          ...basisColumns(evaluation.basis),
          status,
          issues: json(evaluation.issues),
          checked_in_at: now,
          evaluated_at: now,
          admitted_at: status === 'admitted' ? now : null,
          withdrawn_at: null,
          withdrawn_reason: null,
          recorded_by: json(snapshotActor(principal)),
          recorded_by_person_id: principal.personId,
        })
        .returningAll()
        .executeTakeFirstOrThrow()
        .catch((error: unknown) => {
          if (isUniqueViolation(error)) {
            throw errors.resourceConflict('This person is already checked in to this activity.', {
              code: 'already_checked_in',
            });
          }
          throw error;
        });
      await this.afterChange(trx, principal, organizationId, row, null, correlationId, body.reason);
      return toCheckin(row, audienceOfAuthority(authority));
    });
  }

  async recheck(
    principal: Principal,
    id: string,
    body: RecheckSessionCheckinBody,
    correlationId: string | null,
  ): Promise<SessionCheckin> {
    const organizationId = organizationOf(principal);
    const stored = await this.load(this.uow.reader(), organizationId, id);
    if (!stored) throw errors.notFound('session_checkin', id);
    const activity = await this.resolver.resolve(organizationId, refOf(activityDetailOf(stored)));
    const authority = await this.scope.requireForActivity(
      principal,
      EntryActions.checkIn,
      EntryActions.checkInAssigned,
      activity,
    );
    return this.uow.run(async ({ trx }) => {
      const checked = await this.lockForAdmission(trx, organizationId, activity);
      this.requireActivityDay(checked);
      const stored = await this.load(trx, organizationId, id);
      if (!stored) throw errors.notFound('session_checkin', id);
      // R4-OPS-MODULES-04: a re-check may link the person's open visit; read it under the
      // presence lock (serialized with a void or departure of that visit).
      await lockEntrySubjects(trx, [presenceLockKey(organizationId, stored.person_id)]);
      const current = (await this.load(trx, organizationId, id)) ?? stored;
      assertExpectedRevision(body.expectedRevision, current.revision);
      // Only a held check-in is re-evaluated (admitted → admit is not a transition).
      SessionCheckinMachine.next(current.status, 'reevaluate');
      const visit =
        (current.visit_id && (await this.visits.load(trx, organizationId, current.visit_id))) ||
        (await this.visits.openVisit(trx, organizationId, current.facility_id, current.person_id));
      const facility = await this.resolver.facility(organizationId, current.facility_id, trx);
      const evaluation = await this.checks.evaluate(
        trx,
        organizationId,
        current.person_id,
        checked,
        policyForFacility(this.policy, facility.settings),
        visit !== undefined && visit.status === 'on_site',
      );
      const status = hasBlocking(evaluation.issues)
        ? SessionCheckinMachine.next(current.status, 'reevaluate')
        : SessionCheckinMachine.next(current.status, 'admit');
      const now = this.clock.now();
      const result = await trx
        .updateTable('session_checkins')
        .set({
          status,
          issues: json(evaluation.issues),
          ...basisColumns(evaluation.basis),
          visit_id: current.visit_id ?? (visit && visit.status === 'on_site' ? visit.id : null),
          evaluated_at: now,
          admitted_at: status === 'admitted' ? now : null,
          revision: current.revision + 1,
        })
        .where('organization_id', '=', organizationId)
        .where('id', '=', id)
        .where('revision', '=', current.revision)
        .executeTakeFirst();
      ensureUpdated(result.numUpdatedRows, () =>
        errors.staleRevision(body.expectedRevision, current.revision + 1),
      );
      const updated = await this.load(trx, organizationId, id);
      if (!updated) throw errors.notFound('session_checkin', id);
      await this.afterChange(
        trx,
        principal,
        organizationId,
        updated,
        current.status === 'withdrawn' ? null : current.status,
        correlationId,
        body.reason,
      );
      return toCheckin(updated, audienceOfAuthority(authority));
    });
  }

  async withdraw(
    principal: Principal,
    id: string,
    body: WithdrawSessionCheckinBody,
    correlationId: string | null,
  ): Promise<SessionCheckin> {
    const organizationId = organizationOf(principal);
    const stored = await this.load(this.uow.reader(), organizationId, id);
    if (!stored) throw errors.notFound('session_checkin', id);
    const activity = await this.resolver.resolve(organizationId, refOf(activityDetailOf(stored)));
    const authority = await this.scope.requireForActivity(
      principal,
      EntryActions.checkIn,
      EntryActions.checkInAssigned,
      activity,
    );
    return this.uow.run(async ({ trx }) => {
      const current = await this.load(trx, organizationId, id);
      if (!current) throw errors.notFound('session_checkin', id);
      assertExpectedRevision(body.expectedRevision, current.revision);
      const status = SessionCheckinMachine.next(current.status, 'withdraw');
      const result = await trx
        .updateTable('session_checkins')
        .set({
          status,
          withdrawn_at: this.clock.now(),
          withdrawn_reason: body.reason,
          revision: current.revision + 1,
        })
        .where('organization_id', '=', organizationId)
        .where('id', '=', id)
        .where('revision', '=', current.revision)
        .executeTakeFirst();
      ensureUpdated(result.numUpdatedRows, () =>
        errors.staleRevision(body.expectedRevision, current.revision + 1),
      );
      const updated = await this.load(trx, organizationId, id);
      if (!updated) throw errors.notFound('session_checkin', id);
      await this.afterChange(
        trx,
        principal,
        organizationId,
        updated,
        current.status === 'withdrawn' ? null : current.status,
        correlationId,
        body.reason,
      );
      return toCheckin(updated, audienceOfAuthority(authority));
    });
  }

  /**
   * ENT-03 (§4.6, §4.12, SPK-ENTRY-003, SPK-AT-009): an activity was canceled by its owning module
   * (catalog canceled the session, or scheduling canceled the event). Every live (held or
   * admitted) check-in of it is withdrawn through SessionCheckinMachine with the reason
   * `activity_canceled`, audited as the system and announced (entry.session_checkin_changed).
   * Visits stay open: the people are still on site. Replay-safe: an already withdrawn check-in is
   * not live, so a replayed cancellation changes nothing. Runs in the handler's transaction.
   *
   * R2-RACES-06: the cancellation is first recorded (activity_cancellations, once per activity)
   * under the activity's exclusive lock, so a check-in still in flight is either visible to the
   * select below (it committed first and is withdrawn here) or sees the record once it gets the
   * lock (it is held with `activity_canceled`; the database refuses to admit it).
   */
  async withdrawForCanceledActivity(
    trx: Trx,
    organizationId: string,
    activityType: 'session' | 'event',
    activityId: string,
    source: string,
    correlationId: string | null,
  ): Promise<number> {
    await lockActivity(trx, organizationId, activityType, activityId, 'exclusive');
    await trx
      .insertInto('activity_cancellations')
      .values({
        id: newId(),
        organization_id: organizationId,
        activity_type: activityType,
        activity_id: activityId,
        offering_session_id: activityType === 'session' ? activityId : null,
        scheduling_event_id: activityType === 'event' ? activityId : null,
        recorded_at: this.clock.now(),
        source,
      })
      .onConflict((oc) =>
        oc.columns(['organization_id', 'activity_type', 'activity_id']).doNothing(),
      )
      .execute();
    const live = await trx
      .selectFrom('session_checkins')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('activity_type', '=', activityType)
      .where('activity_id', '=', activityId)
      .where('status', 'in', ['held', 'admitted'])
      .orderBy('id')
      .forUpdate()
      .execute();
    const system = systemPrincipal(organizationId, source);
    const now = this.clock.now();
    let withdrawn = 0;
    for (const current of live) {
      const status = SessionCheckinMachine.next(current.status, 'withdraw');
      const result = await trx
        .updateTable('session_checkins')
        .set({
          status,
          withdrawn_at: now,
          withdrawn_reason: ACTIVITY_CANCELED,
          revision: current.revision + 1,
        })
        .where('organization_id', '=', organizationId)
        .where('id', '=', current.id)
        .where('revision', '=', current.revision)
        .executeTakeFirst();
      if (Number(result.numUpdatedRows) === 0) continue;
      const updated = await this.load(trx, organizationId, current.id);
      if (!updated) continue;
      await this.afterChange(
        trx,
        system,
        organizationId,
        updated,
        current.status === 'withdrawn' ? null : current.status,
        correlationId,
        ACTIVITY_CANCELED,
      );
      withdrawn += 1;
    }
    return withdrawn;
  }

  /**
   * R4-OPS-MODULES-07 (SPK-ENTRY-001, SPK-ENTRY-003, §4.12): the owning module moved an activity
   * (catalog.session_retimed; scheduling.event_changed other than a cancellation). A check-in
   * keeps a copy of its activity's times, so every live (held or admitted) check-in whose copy no
   * longer matches the activity as it is now — read in the handler's transaction, never from the
   * payload — follows it:
   *   - moved within the same facility-local day: the stored times are updated (the admission
   *     still stands for that day's activity);
   *   - moved to another day or (an event) another facility: withdrawn through
   *     SessionCheckinMachine with the reason `activity_moved`, so the person can be checked in on
   *     the new day and today's visit no longer counts a session that is not today.
   * Audited as the system and announced (entry.session_checkin_changed). Replay-safe: a check-in
   * already at the current times, or no longer live, is left alone. A canceled activity is left to
   * the cancellation follow-up. Serialized with in-flight check-ins on the activity's exclusive
   * lock (R2-RACES-06), like a cancellation.
   */
  async followActivityTimes(
    trx: Trx,
    organizationId: string,
    activityType: 'session' | 'event',
    activityId: string,
    schedulingEventId: string | null,
    source: string,
    correlationId: string | null,
  ): Promise<{ moved: number; withdrawn: number }> {
    await lockActivity(trx, organizationId, activityType, activityId, 'exclusive');
    const live = await trx
      .selectFrom('session_checkins')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('activity_type', '=', activityType)
      .where('activity_id', '=', activityId)
      .where('status', 'in', ['held', 'admitted'])
      .orderBy('id')
      .forUpdate()
      .execute();
    const outcome = { moved: 0, withdrawn: 0 };
    if (live.length === 0) return outcome;
    const current = await this.currentTimes(
      trx,
      organizationId,
      activityType,
      activityId,
      schedulingEventId ?? live[0]!.scheduling_event_id,
    );
    if (!current || current.canceled) return outcome;
    const system = systemPrincipal(organizationId, source);
    const timezones = new Map<string, string>();
    for (const row of live) {
      const facilityId = current.facilityId ?? row.facility_id;
      const sameTimes =
        new Date(row.activity_start).getTime() === current.start.getTime() &&
        new Date(row.activity_end).getTime() === current.end.getTime();
      if (sameTimes && facilityId === row.facility_id) continue;
      let timezone = timezones.get(row.facility_id);
      if (!timezone) {
        timezone = (await this.resolver.facility(organizationId, row.facility_id, trx)).timezone;
        timezones.set(row.facility_id, timezone);
      }
      const sameDay =
        facilityId === row.facility_id &&
        localDateOf(timezone, new Date(row.activity_start)) ===
          localDateOf(timezone, current.start);
      const previousStatus = row.status === 'withdrawn' ? null : row.status;
      const result = await trx
        .updateTable('session_checkins')
        .set(
          sameDay
            ? { activity_start: current.start, activity_end: current.end }
            : {
                status: SessionCheckinMachine.next(row.status, 'withdraw'),
                withdrawn_at: this.clock.now(),
                withdrawn_reason: ACTIVITY_MOVED,
              },
        )
        .set({ revision: row.revision + 1 })
        .where('organization_id', '=', organizationId)
        .where('id', '=', row.id)
        .where('revision', '=', row.revision)
        .executeTakeFirst();
      // The row is locked, so its revision cannot have moved; a miss retries the delivery.
      if (Number(result.numUpdatedRows) !== 1) {
        throw new Error(`session check-in ${row.id} changed while it was locked`);
      }
      const updated = await this.load(trx, organizationId, row.id);
      if (!updated) continue;
      await this.afterChange(
        trx,
        system,
        organizationId,
        updated,
        previousStatus,
        correlationId,
        sameDay ? 'activity_retimed' : ACTIVITY_MOVED,
      );
      if (sameDay) outcome.moved += 1;
      else outcome.withdrawn += 1;
    }
    return outcome;
  }

  /**
   * The activity's current times from its owning module, read through the given transaction
   * (§4.2: catalog's SessionsService and scheduling's EventsService, never their tables), or null
   * when it cannot be read there (a session not linked to a scheduling event keeps its times).
   */
  private async currentTimes(
    trx: Trx,
    organizationId: string,
    activityType: 'session' | 'event',
    activityId: string,
    schedulingEventId: string | null,
  ): Promise<CurrentActivityTimes | null> {
    if (activityType === 'session') {
      if (!schedulingEventId) return null;
      const session = (
        await this.sessions.sessionsOfSchedulingEvents(trx, organizationId, [schedulingEventId])
      ).find((s) => s.id === activityId);
      if (!session) return null;
      return {
        start: new Date(session.scheduledStart),
        end: new Date(session.scheduledEnd),
        facilityId: null,
        canceled: session.status === 'canceled',
      };
    }
    try {
      // EventsService reads through the active transaction (executorFor).
      const event = await this.events.getEvent(
        systemPrincipal(organizationId, 'entry.activities'),
        activityId,
      );
      return {
        start: new Date(event.scheduledStart),
        end: new Date(event.scheduledEnd),
        facilityId: event.facilityId,
        canceled: event.status === 'canceled',
      };
    } catch (error) {
      if (DomainError.is(error) && error.code === 'NOT_FOUND') return null;
      throw error;
    }
  }

  /**
   * Protected read (§4.14 object- and field-level authorization, SPK-UX-007): desk and support
   * staff of the facility, the coach or official assigned to the check-in's activity, or a holder
   * of `view` over the person; otherwise NOT_FOUND. A customer reads the check-in without the
   * staff actor's identifiers; neither a customer nor the assigned coach or official sees a
   * balance issue or an obligation id (a blocking one reads `desk_review_required`).
   */
  async get(principal: Principal, id: string): Promise<SessionCheckin> {
    const organizationId = organizationOf(principal);
    const row = await this.load(this.uow.reader(), organizationId, id);
    if (!row) throw errors.protectedNotFound('session_checkin');
    const decision = await this.authorization.decide(principal, EntryActions.readCheckin, {
      type: 'session_checkin',
      id,
      organizationId,
      facilityId: row.facility_id,
      subjectPersonIds: [row.person_id],
      protected: true,
    });
    if (decision.allowed) return toCheckin(row, audienceOf(decision.basis));
    const field = await this.authorization.decide(principal, EntryActions.readAssignedCheckin, {
      type: 'session_checkin',
      id,
      organizationId,
      facilityId: row.facility_id,
      protected: true,
    });
    if (field.allowed && principal.personId) {
      const activity = await this.resolver.resolve(organizationId, refOf(activityDetailOf(row)));
      if (await this.scope.isAssigned(organizationId, activity, principal.personId)) {
        return toCheckin(row, 'assigned');
      }
    }
    throw errors.protectedNotFound('session_checkin');
  }

  private async afterChange(
    trx: Trx,
    principal: Principal,
    organizationId: string,
    row: CheckinRow,
    previousStatus: 'held' | 'admitted' | null,
    correlationId: string | null,
    reason?: string | null,
  ): Promise<void> {
    const blocking = (row.issues as Array<{ code: string; severity: string }>)
      .filter((i) => i.severity === 'blocking')
      .map((i) => i.code);
    await this.audit.record(trx, {
      organizationId,
      actor: principal,
      action: EntryActions.checkIn.id,
      targetType: 'session_checkin',
      targetId: row.id,
      beforeRevision: previousStatus ? row.revision - 1 : null,
      afterRevision: row.revision,
      reason: reason ?? row.withdrawn_reason ?? null,
      correlationId,
      details: { status: row.status, previousStatus, blockingIssueCodes: blocking },
    });
    await this.outbox.enqueue(trx, EntryEvents.sessionCheckinChanged, {
      organizationId,
      aggregateType: 'session_checkin',
      aggregateId: row.id,
      payload: {
        checkinId: row.id,
        facilityId: row.facility_id,
        personId: row.person_id,
        activityType: row.activity_type,
        activityId: row.activity_id,
        status: row.status,
        previousStatus,
        blockingIssueCodes: blocking,
      },
      correlationId,
    });
  }

  /**
   * R2-RACES-06 (ENT-03, SPK-AT-009): the first step of a transaction that may admit a check-in.
   * Takes the activity's admission lock (shared) and then reads whether entry has recorded the
   * activity's cancellation. `activity` was resolved from its owning module before the
   * transaction, so a cancellation whose follow-up ran in between is only known here; it then
   * yields the blocking `activity_canceled` issue (the check-in is held, never admitted). A
   * follow-up that runs later waits for this transaction and withdraws what it wrote.
   */
  private async lockForAdmission(
    trx: Trx,
    organizationId: string,
    resolved: ResolvedActivity,
  ): Promise<ResolvedActivity> {
    await lockActivity(trx, organizationId, resolved.detail.type, resolved.detail.id, 'shared');
    // R4-OPS-MODULES-07: the times as the owning module holds them now. A move whose follow-up
    // (`followActivityTimes`, exclusive lock) already ran is only known here; one that runs
    // later waits for this transaction and moves or withdraws what it wrote.
    const fresh = await this.currentTimes(
      trx,
      organizationId,
      resolved.detail.type,
      resolved.detail.id,
      resolved.schedulingEventId,
    );
    const activity: ResolvedActivity =
      fresh && !fresh.canceled ? { ...resolved, start: fresh.start, end: fresh.end } : resolved;
    if (activity.canceled) return activity;
    const recorded = await trx
      .selectFrom('activity_cancellations')
      .select('id')
      .where('organization_id', '=', organizationId)
      .where('activity_type', '=', activity.detail.type)
      .where('activity_id', '=', activity.detail.id)
      .executeTakeFirst();
    return recorded ? { ...activity, canceled: true } : activity;
  }

  /**
   * R4-OPS-MODULES-06 (SPK-ENTRY-001, SPK-ENTRY-004): a check-in is made on the activity's own
   * facility-local day (from its midnight; an activity that has ended stays a warning). One made
   * ahead would hold the person's one live check-in for that activity until the real day and make
   * today's visit leave through a release. Refused before anything is written.
   */
  private requireActivityDay(activity: ResolvedActivity): void {
    if (beforeActivityDay(activity, this.clock.now())) {
      throw errors.resourceConflict(
        'Check-in opens on the day of the activity at its facility; check the person in then.',
        {
          code: 'activity_not_today',
          activityDate: activityDateOf(activity),
          activityStart: activity.start.toISOString(),
        },
      );
    }
  }

  private async live(
    trx: Trx,
    organizationId: string,
    personId: string,
    activity: ResolvedActivity,
  ): Promise<CheckinRow | undefined> {
    return trx
      .selectFrom('session_checkins')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('person_id', '=', personId)
      .where('activity_type', '=', activity.detail.type)
      .where('activity_id', '=', activity.detail.id)
      .where('status', 'in', ['held', 'admitted'])
      .executeTakeFirst();
  }

  private async load(db: Db | Trx, organizationId: string, id: string) {
    return db
      .selectFrom('session_checkins')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', id)
      .executeTakeFirst();
  }
}
