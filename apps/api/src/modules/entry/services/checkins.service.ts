import { Inject, Injectable } from '@nestjs/common';
import {
  errors,
  newId,
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
import { PERSON_DIRECTORY_PORT, type PersonDirectoryPort } from '../../identity';
import { EntryActions } from '../entry.actions';
import { EntryEvents } from '../entry.events';
import { ENTRY_POLICY, policyForFacility, type EntryPolicy } from '../entry.policy';
import { activityDetailOf, organizationOf, toCheckin, type CheckinRow } from '../entry.shared';
import { SessionCheckinMachine } from '../entry.state-machines';
import { ActivityResolver, refOf, type ResolvedActivity } from './activity-resolver';
import { ArrivalChecks, hasBlocking, type ParticipationBasis } from './arrival-checks';
import { StaffScope } from './staff-scope';
import { VisitsService } from './visits.service';

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
  ) {}

  async create(
    principal: Principal,
    body: CreateSessionCheckinBody,
    correlationId: string | null,
  ): Promise<SessionCheckin> {
    const organizationId = organizationOf(principal);
    const activity = await this.resolver.resolve(organizationId, body.activity);
    await this.scope.requireForActivity(
      principal,
      EntryActions.checkIn,
      EntryActions.checkInAssigned,
      activity,
    );
    return this.uow.run(async ({ trx }) => {
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
        activity,
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
          activity_start: activity.start,
          activity_end: activity.end,
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
      return toCheckin(row);
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
    await this.scope.requireForActivity(
      principal,
      EntryActions.checkIn,
      EntryActions.checkInAssigned,
      activity,
    );
    return this.uow.run(async ({ trx }) => {
      const current = await this.load(trx, organizationId, id);
      if (!current) throw errors.notFound('session_checkin', id);
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
        activity,
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
      return toCheckin(updated);
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
    await this.scope.requireForActivity(
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
      return toCheckin(updated);
    });
  }

  /** Protected read: staff of the facility, the assigned coach, or a holder of `view` over the person. */
  async get(principal: Principal, id: string): Promise<SessionCheckin> {
    const organizationId = organizationOf(principal);
    const row = await this.load(this.uow.reader(), organizationId, id);
    if (!row) throw errors.protectedNotFound('session_checkin');
    await this.authorization.require(principal, EntryActions.readCheckin, {
      type: 'session_checkin',
      id,
      organizationId,
      facilityId: row.facility_id,
      subjectPersonIds: [row.person_id],
      protected: true,
    });
    return toCheckin(row);
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
