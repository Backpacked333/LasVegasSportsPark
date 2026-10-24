import { Inject, Injectable } from '@nestjs/common';
import {
  ApplicationMachine,
  errors,
  newId,
  type Application,
  type ApplicationState,
  type CreateApplicationInput,
  type DecideApplicationInput,
  type DeclineApplicationInput,
  type EligibilityResult,
  type ListApplicationsQuery,
  type OfferingSession,
  type OverrideEligibilityInput,
  type Page,
  type Principal,
  type RegistrationIntent,
  type WithdrawApplicationInput,
} from '@sportspark/contracts';
import { isUniqueViolation, json, type ApplicationsTable, type Db } from '@sportspark/db';
import type { Selectable } from 'kysely';
import {
  AuditWriter,
  AuthorizationService,
  CLOCK,
  DATABASE,
  Outbox,
  UnitOfWork,
  assertExpectedRevision,
  type Clock,
  type Trx,
} from '../../../kernel';
import { SessionsService, type OfferingSnapshot } from '../../catalog';
import type { PersonSummary } from '../../identity';
import { EnrollmentActions } from '../enrollment.actions';
import { EnrollmentEvents } from '../enrollment.events';
import { actorSnapshot, isStaffLike, organizationOf, toApplication, type Reader } from '../enrollment.shared';
import { EnrollmentsService } from './enrollments.service';
import { RegistrationEvaluator, type Evaluation } from './registration-evaluator';

export type ApplicationRow = Selectable<ApplicationsTable>;

export interface CreateApplicationInTrx {
  snapshot: OfferingSnapshot;
  person: PersonSummary;
  intent: RegistrationIntent;
  evaluation: Evaluation;
  payerPersonId: string | null;
  teamEntryId: string | null;
  sessionId: string | null;
  notes: string | null;
  actor: Principal;
  correlationId: string | null;
}

/**
 * Applications (§4.4 Application, SPK-REG-001..003, SPK-REG-007, SPK-REG-009, ApplicationMachine
 * §4.6). An application records the intent, the explainable eligibility evaluation and the human
 * approval decision — independently of the enrollment, placement and financial obligation it may
 * lead to (SPK-REG-003). Eligibility that fails is kept on the record so staff with authority can
 * override it with a reason and an audit trail (SPK-REG-002).
 */
@Injectable()
export class ApplicationsService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly evaluator: RegistrationEvaluator,
    private readonly enrollments: EnrollmentsService,
    private readonly sessions: SessionsService,
  ) {}

  async load(db: Reader, organizationId: string, id: string, forUpdate = false): Promise<ApplicationRow | undefined> {
    let q = db.selectFrom('applications').selectAll().where('organization_id', '=', organizationId).where('id', '=', id);
    if (forUpdate) q = q.forUpdate();
    return q.executeTakeFirst();
  }

  /** The current application of a participant for an offering (open or accepted and not yet used). */
  async findCurrent(db: Reader, organizationId: string, offeringId: string, participantPersonId: string): Promise<ApplicationRow | undefined> {
    return db
      .selectFrom('applications')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('offering_id', '=', offeringId)
      .where('participant_person_id', '=', participantPersonId)
      .where('status', 'in', ['submitted', 'awaiting_review', 'accepted'])
      .orderBy('created_at', 'desc')
      .executeTakeFirst();
  }

  /** The catalog session named on a session-scoped intent, through the catalog service (visibility applies). */
  async sessionFor(principal: Principal, offeringId: string, sessionId: string | null | undefined): Promise<OfferingSession | null | undefined> {
    if (!sessionId) return undefined;
    const sessions = await this.sessions.list(principal, offeringId);
    const session = sessions.find((s) => s.id === sessionId);
    if (!session) throw errors.notFound('offering_session', sessionId);
    return session;
  }

  // -------------------------------------------------------------------------------------------
  // POST /applications
  // -------------------------------------------------------------------------------------------

  async create(principal: Principal, input: CreateApplicationInput, correlationId: string | null): Promise<Application> {
    const organizationId = organizationOf(principal);
    // The catalog session is read before the transaction (it reads through its own service).
    const session = await this.sessionFor(principal, input.offeringId, input.sessionId);
    return this.uow.run(async ({ trx }) => {
      const person = await this.evaluator.participant(trx, organizationId, input.participantPersonId);
      await this.authorization.require(principal, EnrollmentActions.apply, {
        type: 'application',
        organizationId,
        subjectPersonIds: [person.id],
      });
      const snapshot = await this.evaluator.snapshot(trx, organizationId, input.offeringId);
      const evaluation = await this.evaluator.evaluate(trx, organizationId, {
        snapshot,
        person,
        intent: input.intent,
        teamEntryId: input.teamEntryId ?? null,
        session,
      });
      const existing = await this.findCurrent(trx, organizationId, snapshot.offering.id, person.id);
      if (existing) {
        // SPK-AT-004: one application per participant and offering, whichever guardian asks; the
        // other household member's identity and payer are never revealed.
        throw errors.duplicateEntitlement('An application for this participant and offering already exists.', {
          participantPersonId: person.id,
          offeringId: snapshot.offering.id,
          applicationStatus: existing.status,
        });
      }
      const equivalence = this.evaluator.equivalence(snapshot, person.id, session?.id ?? null);
      if (await this.enrollments.findEquivalentActive(trx, organizationId, person.id, equivalence)) {
        throw errors.duplicateEntitlement('An equivalent active registration already exists for this participant.', {
          participantPersonId: person.id,
          offeringId: snapshot.offering.id,
        });
      }
      const row = await this.createInTrx(trx, organizationId, {
        snapshot,
        person,
        intent: input.intent,
        evaluation,
        payerPersonId: input.payerPersonId ?? (isStaffLike(principal) ? null : principal.personId),
        teamEntryId: input.teamEntryId ?? null,
        sessionId: session?.id ?? null,
        notes: input.notes ?? null,
        actor: principal,
        correlationId,
      });
      return toApplication(row);
    });
  }

  /**
   * Writes the application and runs the machine: draft → submitted, then accepted when eligible
   * and no approval is needed, awaiting_review when approval is needed (SPK-REG-007), or left
   * submitted when eligibility failed so staff can override or decline it (SPK-REG-002).
   */
  async createInTrx(trx: Trx, organizationId: string, input: CreateApplicationInTrx): Promise<ApplicationRow> {
    const now = this.clock.now();
    const id = newId();
    let status: ApplicationState = ApplicationMachine.next('draft', 'submit');
    if (input.evaluation.result.eligible) {
      status = input.evaluation.requiresApproval
        ? ApplicationMachine.next(status, 'route_for_review')
        : ApplicationMachine.next(status, 'accept');
    }
    const accepted = status === 'accepted';
    try {
      await trx
        .insertInto('applications')
        .values({
          id,
          organization_id: organizationId,
          offering_id: input.snapshot.offering.id,
          participant_person_id: input.person.id,
          intent: input.intent,
          submitted_by: json(actorSnapshot(input.actor)),
          submitted_by_person_id: input.actor.personId,
          payer_person_id: input.payerPersonId,
          status,
          eligibility_result: json(input.evaluation.result),
          override: null,
          requires_approval: input.evaluation.requiresApproval,
          team_entry_id: input.teamEntryId,
          session_id: input.sessionId,
          notes: input.notes,
          submitted_at: now,
          decided_at: accepted ? now : null,
          decided_by: accepted ? json({ kind: 'system', actorLabel: 'enrollment.auto_accept' }) : null,
          decided_by_person_id: null,
          decision_reason: accepted ? 'Eligible; no human approval is configured for this intent.' : null,
          withdrawn_at: null,
        })
        .execute();
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw errors.duplicateEntitlement('An application for this participant and offering already exists.', {
          participantPersonId: input.person.id,
          offeringId: input.snapshot.offering.id,
        });
      }
      throw error;
    }
    await this.audit.record(trx, {
      organizationId,
      actor: input.actor,
      action: EnrollmentActions.apply.id,
      targetType: 'application',
      targetId: id,
      afterRevision: 1,
      correlationId: input.correlationId,
      details: {
        offeringId: input.snapshot.offering.id,
        intent: input.intent,
        status,
        eligible: input.evaluation.result.eligible,
        reasonCodes: input.evaluation.result.reasons.map((r) => r.code),
        requiresApproval: input.evaluation.requiresApproval,
        assistedByStaff: isStaffLike(input.actor),
      },
    });
    await this.outbox.enqueue(trx, EnrollmentEvents.applicationSubmitted, {
      organizationId,
      aggregateType: 'application',
      aggregateId: id,
      correlationId: input.correlationId,
      payload: {
        organizationId,
        applicationId: id,
        offeringId: input.snapshot.offering.id,
        participantPersonId: input.person.id,
        intent: input.intent,
        status,
        eligible: input.evaluation.result.eligible,
        requiresApproval: input.evaluation.requiresApproval,
      },
    });
    const row = await this.load(trx, organizationId, id);
    if (!row) throw errors.internal('application vanished');
    return row;
  }

  // -------------------------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------------------------

  async get(principal: Principal, id: string): Promise<Application> {
    const organizationId = organizationOf(principal);
    const row = await this.load(this.db, organizationId, id);
    if (!row) throw errors.protectedNotFound('application');
    await this.authorization.require(principal, EnrollmentActions.readApplication, {
      type: 'application',
      id,
      organizationId,
      subjectPersonIds: [row.participant_person_id],
      protected: true,
    });
    return toApplication(row);
  }

  async list(principal: Principal, query: ListApplicationsQuery): Promise<Page<Application>> {
    const organizationId = organizationOf(principal);
    if (isStaffLike(principal)) {
      await this.authorization.require(principal, EnrollmentActions.listApplications, {
        type: 'application',
        organizationId,
      });
    } else {
      if (!query.participantPersonId) throw errors.validation('participantPersonId is required.');
      await this.authorization.require(principal, EnrollmentActions.readApplication, {
        type: 'application',
        organizationId,
        subjectPersonIds: [query.participantPersonId],
        protected: true,
      });
    }
    let q = this.db
      .selectFrom('applications')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .orderBy('submitted_at', 'desc')
      .orderBy('id', 'desc')
      .limit(query.limit);
    if (query.offeringId) q = q.where('offering_id', '=', query.offeringId);
    if (query.participantPersonId) q = q.where('participant_person_id', '=', query.participantPersonId);
    if (query.status) q = q.where('status', '=', query.status);
    const rows = await q.execute();
    return { items: rows.map(toApplication), nextCursor: null };
  }

  // -------------------------------------------------------------------------------------------
  // Override (SPK-REG-002: specific authority, reason, audit history)
  // -------------------------------------------------------------------------------------------

  async overrideEligibility(principal: Principal, id: string, input: OverrideEligibilityInput, correlationId: string | null): Promise<Application> {
    const organizationId = organizationOf(principal);
    const now = this.clock.now();
    return this.uow.run(async ({ trx }) => {
      const row = await this.load(trx, organizationId, id, true);
      if (!row) throw errors.protectedNotFound('application');
      await this.authorization.require(principal, EnrollmentActions.overrideEligibility, {
        type: 'application',
        id,
        organizationId,
        facilityId: null,
      });
      assertExpectedRevision(input.expectedRevision, row.revision);
      const result = row.eligibility_result as unknown as EligibilityResult;
      if (row.status !== 'submitted' || result.eligible) {
        throw errors.invalidTransition('Application', row.status, 'override_eligibility');
      }
      const overridden: EligibilityResult = {
        ...result,
        eligible: true,
        overridden: true,
        reasons: result.reasons.map((r) => ({ ...r, severity: r.severity === 'warning' ? 'warning' : 'info' })),
      };
      const status = row.requires_approval
        ? ApplicationMachine.next(row.status, 'route_for_review')
        : ApplicationMachine.next(row.status, 'accept');
      await trx
        .updateTable('applications')
        .set({
          status,
          eligibility_result: json(overridden),
          override: json({
            actorPersonId: principal.personId,
            actorLabel: principal.actorLabel,
            reason: input.reason,
            overriddenAt: now.toISOString(),
            originalReasons: result.reasons,
          }),
          decided_at: status === 'accepted' ? now : null,
          decided_by: status === 'accepted' ? json(actorSnapshot(principal)) : null,
          decided_by_person_id: status === 'accepted' ? principal.personId : null,
          decision_reason: status === 'accepted' ? input.reason : null,
          revision: row.revision + 1,
        })
        .where('organization_id', '=', organizationId)
        .where('id', '=', id)
        .where('revision', '=', row.revision)
        .execute();
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: EnrollmentActions.overrideEligibility.id,
        targetType: 'application',
        targetId: id,
        beforeRevision: row.revision,
        afterRevision: row.revision + 1,
        reason: input.reason,
        correlationId,
        details: { originalReasonCodes: result.reasons.map((r) => r.code), status },
      });
      await this.outbox.enqueue(trx, EnrollmentEvents.eligibilityOverridden, {
        organizationId,
        aggregateType: 'application',
        aggregateId: id,
        correlationId,
        payload: { organizationId, applicationId: id, offeringId: row.offering_id, reason: input.reason },
      });
      if (status === 'accepted') await this.enqueueDecided(trx, organizationId, row, status, correlationId);
      return toApplication((await this.load(trx, organizationId, id))!);
    });
  }

  // -------------------------------------------------------------------------------------------
  // Review decisions (SPK-REG-007) and withdrawal
  // -------------------------------------------------------------------------------------------

  async accept(principal: Principal, id: string, input: DecideApplicationInput, correlationId: string | null): Promise<Application> {
    return this.decide(principal, id, 'accept', input.expectedRevision, input.reason ?? null, correlationId);
  }

  async decline(principal: Principal, id: string, input: DeclineApplicationInput, correlationId: string | null): Promise<Application> {
    return this.decide(principal, id, 'decline', input.expectedRevision, input.reason, correlationId);
  }

  private async decide(principal: Principal, id: string, event: 'accept' | 'decline', expectedRevision: number, reason: string | null, correlationId: string | null): Promise<Application> {
    const organizationId = organizationOf(principal);
    const now = this.clock.now();
    return this.uow.run(async ({ trx }) => {
      const row = await this.load(trx, organizationId, id, true);
      if (!row) throw errors.protectedNotFound('application');
      await this.authorization.require(principal, EnrollmentActions.reviewApplication, {
        type: 'application',
        id,
        organizationId,
      });
      assertExpectedRevision(expectedRevision, row.revision);
      const result = row.eligibility_result as unknown as EligibilityResult;
      if (event === 'accept' && !result.eligible) {
        throw errors.eligibility('The application failed eligibility; override it first.', {
          reasons: result.reasons,
          alternatives: result.alternatives,
        });
      }
      const status = ApplicationMachine.next(row.status, event);
      await trx
        .updateTable('applications')
        .set({
          status,
          decided_at: now,
          decided_by: json(actorSnapshot(principal)),
          decided_by_person_id: principal.personId,
          decision_reason: reason,
          revision: row.revision + 1,
        })
        .where('organization_id', '=', organizationId)
        .where('id', '=', id)
        .where('revision', '=', row.revision)
        .execute();
      if (status === 'declined') await this.releaseLinkedLines(trx, organizationId, id, 'application_declined', principal, correlationId);
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: EnrollmentActions.reviewApplication.id,
        targetType: 'application',
        targetId: id,
        beforeRevision: row.revision,
        afterRevision: row.revision + 1,
        reason,
        correlationId,
        details: { decision: status },
      });
      await this.enqueueDecided(trx, organizationId, row, status, correlationId);
      return toApplication((await this.load(trx, organizationId, id))!);
    });
  }

  async withdraw(principal: Principal, id: string, input: WithdrawApplicationInput, correlationId: string | null): Promise<Application> {
    const organizationId = organizationOf(principal);
    const now = this.clock.now();
    return this.uow.run(async ({ trx }) => {
      const row = await this.load(trx, organizationId, id, true);
      if (!row) throw errors.protectedNotFound('application');
      await this.authorization.require(principal, EnrollmentActions.withdrawApplication, {
        type: 'application',
        id,
        organizationId,
        subjectPersonIds: [row.participant_person_id],
        protected: true,
      });
      assertExpectedRevision(input.expectedRevision, row.revision);
      const status = ApplicationMachine.next(row.status, 'withdraw');
      await trx
        .updateTable('applications')
        .set({ status, withdrawn_at: now, revision: row.revision + 1 })
        .where('organization_id', '=', organizationId)
        .where('id', '=', id)
        .where('revision', '=', row.revision)
        .execute();
      await this.releaseLinkedLines(trx, organizationId, id, 'application_withdrawn', principal, correlationId);
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: EnrollmentActions.withdrawApplication.id,
        targetType: 'application',
        targetId: id,
        beforeRevision: row.revision,
        afterRevision: row.revision + 1,
        reason: input.reason ?? null,
        correlationId,
      });
      await this.outbox.enqueue(trx, EnrollmentEvents.applicationWithdrawn, {
        organizationId,
        aggregateType: 'application',
        aggregateId: id,
        correlationId,
        payload: { organizationId, applicationId: id, offeringId: row.offering_id },
      });
      return toApplication((await this.load(trx, organizationId, id))!);
    });
  }

  /** A declined or withdrawn application frees any pending enrollment a basket line created for it. */
  private async releaseLinkedLines(trx: Trx, organizationId: string, applicationId: string, reason: string, actor: Principal, correlationId: string | null): Promise<void> {
    const lines = await trx
      .selectFrom('basket_lines')
      .select(['id', 'enrollment_id'])
      .where('organization_id', '=', organizationId)
      .where('application_id', '=', applicationId)
      .execute();
    for (const line of lines) {
      if (line.enrollment_id) {
        const enrollment = await this.enrollments.load(trx, organizationId, line.enrollment_id, true);
        if (enrollment && enrollment.status === 'pending') {
          await this.enrollments.cancelInTrx(trx, organizationId, enrollment, reason, actor, correlationId, null, 'failed');
        }
      } else {
        await trx
          .updateTable('basket_lines')
          .set((eb) => ({ outcome: 'failed', outcome_reason: reason, revision: eb('revision', '+', 1) }))
          .where('organization_id', '=', organizationId)
          .where('id', '=', line.id)
          .where('outcome', 'in', ['pending', 'held'])
          .execute();
      }
    }
  }

  private async enqueueDecided(trx: Trx, organizationId: string, row: ApplicationRow, status: ApplicationState, correlationId: string | null): Promise<void> {
    await this.outbox.enqueue(trx, EnrollmentEvents.applicationDecided, {
      organizationId,
      aggregateType: 'application',
      aggregateId: row.id,
      correlationId,
      payload: {
        organizationId,
        applicationId: row.id,
        offeringId: row.offering_id,
        participantPersonId: row.participant_person_id,
        status,
      },
    });
  }
}
