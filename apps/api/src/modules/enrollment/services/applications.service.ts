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
import type { OfferingSnapshot } from '../../catalog';
import type { PersonSummary } from '../../identity';
import { EnrollmentActions } from '../enrollment.actions';
import { EnrollmentEvents } from '../enrollment.events';
import {
  actorSnapshot,
  beforeCursor,
  cursorAt,
  decodeCreatedCursor,
  hiddenFrom,
  isStaffLike,
  keysetPage,
  organizationOf,
  redactApplication,
  resolveCustomerPayer,
  toApplication,
  type Reader,
} from '../enrollment.shared';
import { CatalogSessions } from './catalog-sessions';
import { EnrollmentsService } from './enrollments.service';
import { EnrollmentFacilityScope } from './facility-scope';
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
    private readonly sessions: CatalogSessions,
    private readonly scope: EnrollmentFacilityScope,
  ) {}

  async load(
    db: Reader,
    organizationId: string,
    id: string,
    forUpdate = false,
  ): Promise<ApplicationRow | undefined> {
    let q = db
      .selectFrom('applications')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', id);
    if (forUpdate) q = q.forUpdate();
    return q.executeTakeFirst();
  }

  /**
   * The current application of a participant for an offering (SPK-AT-004, SPK-REG-002/003):
   * - one under review (`submitted`, `awaiting_review`), whoever made it (one per participant and
   *   offering, also enforced by `applications_open_idx`);
   * - an accepted one whose participation is live (a pending or confirmed enrollment came from it),
   *   whoever made it;
   * - an accepted one of the caller's own `household` (submitted by, or paid by, one of those
   *   adults) whose participation has not ended, so an approval or override is reused by the
   *   household's next basket line.
   * Another household's accepted application that never produced a live enrollment (its line was
   * released, removed or abandoned) no longer blocks: the one equivalent entitlement is guaranteed
   * by `enrollments_equivalent_active_idx`, where the first hold wins (§4.7 invariant 2).
   */
  async findCurrent(
    db: Reader,
    organizationId: string,
    offeringId: string,
    participantPersonId: string,
    household: ReadonlyArray<string | null | undefined>,
  ): Promise<ApplicationRow | undefined> {
    const own = [...new Set(household.filter((id): id is string => typeof id === 'string'))];
    return db
      .selectFrom('applications')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('offering_id', '=', offeringId)
      .where('participant_person_id', '=', participantPersonId)
      .where((eb) => {
        const sourced = (
          statuses: Array<'pending' | 'confirmed' | 'canceled' | 'transferred' | 'completed'>,
        ) =>
          eb.exists(
            eb
              .selectFrom('enrollments')
              .select('enrollments.id')
              .whereRef('enrollments.organization_id', '=', 'applications.organization_id')
              .whereRef('enrollments.source_application_id', '=', 'applications.id')
              .where('enrollments.status', 'in', statuses),
          );
        const branches = [
          eb('status', 'in', ['submitted', 'awaiting_review']),
          eb.and([eb('status', '=', 'accepted'), sourced(['pending', 'confirmed'])]),
        ];
        if (own.length > 0) {
          branches.push(
            eb.and([
              eb('status', '=', 'accepted'),
              eb.not(sourced(['canceled', 'transferred', 'completed'])),
              eb.or([eb('submitted_by_person_id', 'in', own), eb('payer_person_id', 'in', own)]),
            ]),
          );
        }
        return eb.or(branches);
      })
      .orderBy('created_at', 'desc')
      .executeTakeFirst();
  }

  /**
   * SPK-REG-002/007: an application (its approval and any override on it) covers the intent it was
   * made for. An accepted application for another intent is terminal and is not reused (the caller
   * creates one for this intent); one still under review for another intent must be withdrawn
   * first, since a participant has one application under review per offering.
   */
  forIntent(
    application: ApplicationRow | undefined,
    intent: RegistrationIntent,
  ): ApplicationRow | undefined {
    if (!application || application.intent === intent) return application;
    if (application.status === 'accepted') return undefined;
    throw errors.resourceConflict(
      'An application for another intent is under review for this participant and offering; withdraw it first.',
      {
        code: 'APPLICATION_INTENT_MISMATCH',
        applicationId: application.id,
        applicationIntent: application.intent,
        intent,
      },
    );
  }

  /** The catalog session named on a session-scoped intent (read before the transaction). */
  async sessionFor(
    organizationId: string,
    offeringId: string,
    sessionId: string | null | undefined,
  ): Promise<OfferingSession | undefined> {
    if (!sessionId) return undefined;
    return this.sessions.get(organizationId, offeringId, sessionId);
  }

  // -------------------------------------------------------------------------------------------
  // POST /applications
  // -------------------------------------------------------------------------------------------

  async create(
    principal: Principal,
    input: CreateApplicationInput,
    correlationId: string | null,
  ): Promise<Application> {
    const organizationId = organizationOf(principal);
    // The catalog session is read before the transaction (it reads through its own service).
    const session = await this.sessionFor(organizationId, input.offeringId, input.sessionId);
    return this.uow.run(async ({ trx }) => {
      const person = await this.evaluator.participant(
        trx,
        organizationId,
        input.participantPersonId,
      );
      await this.authorization.require(principal, EnrollmentActions.apply, {
        type: 'application',
        organizationId,
        facilityId: await this.scope.facilityOf(organizationId, input.offeringId, trx),
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
      // §4.7 (1), SPK-REG-009: a customer pays for their own application; staff may name a payer.
      const payerPersonId =
        resolveCustomerPayer(principal, input.payerPersonId, [principal.personId]) ??
        (isStaffLike(principal) ? null : principal.personId);
      const existing = await this.findCurrent(
        trx,
        organizationId,
        snapshot.offering.id,
        person.id,
        [principal.personId, payerPersonId],
      );
      if (existing) {
        // SPK-AT-004: one live application per participant and offering, whichever guardian asks
        // (one under review, or one whose registration is live, or this household's own); the
        // other household member's identity and payer are never revealed.
        throw errors.duplicateEntitlement(
          'An application for this participant and offering already exists.',
          {
            participantPersonId: person.id,
            offeringId: snapshot.offering.id,
          },
        );
      }
      const equivalence = this.evaluator.equivalence(snapshot, person.id, session?.id ?? null);
      if (
        await this.enrollments.findEquivalentActive(trx, organizationId, person.id, equivalence)
      ) {
        throw errors.duplicateEntitlement(
          'An equivalent active registration already exists for this participant.',
          {
            participantPersonId: person.id,
            offeringId: snapshot.offering.id,
          },
        );
      }
      const row = await this.createInTrx(trx, organizationId, {
        snapshot,
        person,
        intent: input.intent,
        evaluation,
        payerPersonId,
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
  async createInTrx(
    trx: Trx,
    organizationId: string,
    input: CreateApplicationInTrx,
  ): Promise<ApplicationRow> {
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
          decided_by: accepted
            ? json({ kind: 'system', actorLabel: 'enrollment.auto_accept' })
            : null,
          decided_by_person_id: null,
          decision_reason: accepted
            ? 'Eligible; no human approval is configured for this intent.'
            : null,
          withdrawn_at: null,
        })
        .execute();
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw errors.duplicateEntitlement(
          'An application for this participant and offering already exists.',
          {
            participantPersonId: input.person.id,
            offeringId: input.snapshot.offering.id,
          },
        );
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
      facilityId: await this.scope.facilityOf(organizationId, row.offering_id),
      subjectPersonIds: [row.participant_person_id],
      protected: true,
    });
    return redactApplication(principal, toApplication(row));
  }

  async list(principal: Principal, query: ListApplicationsQuery): Promise<Page<Application>> {
    const organizationId = organizationOf(principal);
    const facilityId = await this.scope.facilityOf(organizationId, query.offeringId);
    if (isStaffLike(principal)) {
      await this.authorization.require(principal, EnrollmentActions.listApplications, {
        type: 'application',
        organizationId,
        facilityId,
      });
    } else {
      if (!query.participantPersonId) throw errors.validation('participantPersonId is required.');
      await this.authorization.require(principal, EnrollmentActions.readApplication, {
        type: 'application',
        organizationId,
        facilityId,
        subjectPersonIds: [query.participantPersonId],
        protected: true,
      });
    }
    // §4.3, §4.14: facility-scoped staff list only their facilities' applications.
    const offerings = await this.scope.listOfferings(
      principal,
      EnrollmentActions.listApplications,
      organizationId,
      query.participantPersonId,
    );
    if (offerings?.length === 0) return { items: [], nextCursor: null };
    // ENR-02 (§4.5): keyset pages, newest first (created_at desc, id desc).
    const cursor = decodeCreatedCursor(query.cursor);
    let q = this.db
      .selectFrom('applications')
      .selectAll()
      .select(cursorAt('applications').as('cursor_at'))
      .where('organization_id', '=', organizationId)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(query.limit + 1);
    if (query.offeringId) q = q.where('offering_id', '=', query.offeringId);
    if (offerings) q = q.where('offering_id', 'in', offerings);
    if (query.participantPersonId)
      q = q.where('participant_person_id', '=', query.participantPersonId);
    if (query.status) q = q.where('status', '=', query.status);
    if (cursor) q = q.where(beforeCursor('applications', cursor));
    const page = keysetPage(await q.execute(), query.limit);
    return {
      items: page.rows.map((r) => redactApplication(principal, toApplication(r))),
      nextCursor: page.nextCursor,
    };
  }

  // -------------------------------------------------------------------------------------------
  // Override (SPK-REG-002: specific authority, reason, audit history)
  // -------------------------------------------------------------------------------------------

  async overrideEligibility(
    principal: Principal,
    id: string,
    input: OverrideEligibilityInput,
    correlationId: string | null,
  ): Promise<Application> {
    const organizationId = organizationOf(principal);
    const now = this.clock.now();
    return this.uow.run(async ({ trx }) => {
      const row = await this.load(trx, organizationId, id, true);
      if (!row) throw errors.protectedNotFound('application');
      // Staff-only; a customer of another household must not learn that the application exists.
      await this.authorization.require(principal, EnrollmentActions.overrideEligibility, {
        type: 'application',
        id,
        organizationId,
        facilityId: await this.scope.facilityOf(organizationId, row.offering_id, trx),
        subjectPersonIds: [row.participant_person_id],
        protected: await hiddenFrom(
          this.authorization,
          principal,
          EnrollmentActions.readApplication,
          {
            type: 'application',
            id,
            organizationId,
            subjectPersonIds: [row.participant_person_id],
          },
        ),
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
        reasons: result.reasons.map((r) => ({
          ...r,
          severity: r.severity === 'warning' ? 'warning' : 'info',
        })),
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
        payload: {
          organizationId,
          applicationId: id,
          offeringId: row.offering_id,
          reason: input.reason,
        },
      });
      if (status === 'accepted')
        await this.enqueueDecided(trx, organizationId, row, status, correlationId);
      return toApplication((await this.load(trx, organizationId, id))!);
    });
  }

  // -------------------------------------------------------------------------------------------
  // Review decisions (SPK-REG-007) and withdrawal
  // -------------------------------------------------------------------------------------------

  async accept(
    principal: Principal,
    id: string,
    input: DecideApplicationInput,
    correlationId: string | null,
  ): Promise<Application> {
    return this.decide(
      principal,
      id,
      'accept',
      input.expectedRevision,
      input.reason ?? null,
      correlationId,
    );
  }

  async decline(
    principal: Principal,
    id: string,
    input: DeclineApplicationInput,
    correlationId: string | null,
  ): Promise<Application> {
    return this.decide(
      principal,
      id,
      'decline',
      input.expectedRevision,
      input.reason,
      correlationId,
    );
  }

  private async decide(
    principal: Principal,
    id: string,
    event: 'accept' | 'decline',
    expectedRevision: number,
    reason: string | null,
    correlationId: string | null,
  ): Promise<Application> {
    const organizationId = organizationOf(principal);
    const now = this.clock.now();
    return this.uow.run(async ({ trx }) => {
      const row = await this.load(trx, organizationId, id, true);
      if (!row) throw errors.protectedNotFound('application');
      await this.authorization.require(principal, EnrollmentActions.reviewApplication, {
        type: 'application',
        id,
        organizationId,
        facilityId: await this.scope.facilityOf(organizationId, row.offering_id, trx),
        subjectPersonIds: [row.participant_person_id],
        protected: await hiddenFrom(
          this.authorization,
          principal,
          EnrollmentActions.readApplication,
          {
            type: 'application',
            id,
            organizationId,
            subjectPersonIds: [row.participant_person_id],
          },
        ),
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
      if (status === 'declined')
        await this.releaseLinkedLines(
          trx,
          organizationId,
          id,
          'application_declined',
          principal,
          correlationId,
        );
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

  async withdraw(
    principal: Principal,
    id: string,
    input: WithdrawApplicationInput,
    correlationId: string | null,
  ): Promise<Application> {
    const organizationId = organizationOf(principal);
    const now = this.clock.now();
    return this.uow.run(async ({ trx }) => {
      const row = await this.load(trx, organizationId, id, true);
      if (!row) throw errors.protectedNotFound('application');
      await this.authorization.require(principal, EnrollmentActions.withdrawApplication, {
        type: 'application',
        id,
        organizationId,
        facilityId: await this.scope.facilityOf(organizationId, row.offering_id, trx),
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
      await this.releaseLinkedLines(
        trx,
        organizationId,
        id,
        'application_withdrawn',
        principal,
        correlationId,
      );
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
      return redactApplication(
        principal,
        toApplication((await this.load(trx, organizationId, id))!),
      );
    });
  }

  /** A declined or withdrawn application frees any pending enrollment a basket line created for it. */
  private async releaseLinkedLines(
    trx: Trx,
    organizationId: string,
    applicationId: string,
    reason: string,
    actor: Principal,
    correlationId: string | null,
  ): Promise<void> {
    const lines = await trx
      .selectFrom('basket_lines')
      .select(['id', 'enrollment_id'])
      .where('organization_id', '=', organizationId)
      .where('application_id', '=', applicationId)
      .execute();
    for (const line of lines) {
      if (line.enrollment_id) {
        const enrollment = await this.enrollments.load(
          trx,
          organizationId,
          line.enrollment_id,
          true,
        );
        if (enrollment && enrollment.status === 'pending') {
          await this.enrollments.cancelInTrx(
            trx,
            organizationId,
            enrollment,
            reason,
            actor,
            correlationId,
            null,
            'failed',
          );
        }
      } else {
        await trx
          .updateTable('basket_lines')
          .set((eb) => ({
            outcome: 'failed',
            outcome_reason: reason,
            revision: eb('revision', '+', 1),
          }))
          .where('organization_id', '=', organizationId)
          .where('id', '=', line.id)
          .where('outcome', 'in', ['pending', 'held'])
          .execute();
      }
    }
  }

  private async enqueueDecided(
    trx: Trx,
    organizationId: string,
    row: ApplicationRow,
    status: ApplicationState,
    correlationId: string | null,
  ): Promise<void> {
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
