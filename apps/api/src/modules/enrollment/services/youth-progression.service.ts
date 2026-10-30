import { Inject, Injectable } from '@nestjs/common';
import {
  errors,
  newId,
  type Assessment,
  type AssessmentTemplate,
  type CreateAssessmentInput,
  type CreateAssessmentTemplateInput,
  type CreateProgressionRecommendationInput,
  type DomainEvent,
  type Page,
  type ParticipantAssessmentsQuery,
  type Principal,
  type ProgressionRecommendation,
  type ReviewAssessmentInput,
  type UpdateAssessmentInput,
  type YouthFeedback,
} from '@sportspark/contracts';
import {
  json,
  type AssessmentTemplatesTable,
  type AssessmentsTable,
  type Db,
  type ProgressionRecommendationsTable,
} from '@sportspark/db';
import type { Selectable } from 'kysely';
import {
  AuditWriter,
  AuthorizationService,
  CLOCK,
  CapabilityService,
  DATABASE,
  Outbox,
  UnitOfWork,
  assertExpectedRevision,
  type Clock,
  type Trx,
} from '../../../kernel';
import { OFFERING_LOOKUP_PORT, type OfferingLookupPort } from '../../catalog';
import { NotificationsService } from '../../communications';
import { ASSIGNMENT_COVERAGE_PORT, type AssignmentCoveragePort } from '../../workforce';
import { EnrollmentActions } from '../enrollment.actions';
import { EnrollmentPackageGEvents } from '../enrollment.events';
import {
  actorSnapshot,
  beforeCursor,
  cursorAt,
  decodeCreatedCursor,
  enrollmentSystem,
  iso,
  isoOrNull,
  keysetPage,
  organizationOf,
} from '../enrollment.shared';
import {
  AssessmentMachine,
  AssessmentTemplateMachine,
  ProgressionRecommendationMachine,
  type AssessmentEvent,
} from '../enrollment.state-machines';
import { CustomerScope } from './customer-scope';
import { EnrollmentFacilityScope } from './facility-scope';
import { RegistrationEvaluator } from './registration-evaluator';

type TemplateRow = Selectable<AssessmentTemplatesTable>;
type AssessmentRow = Selectable<AssessmentsTable>;
type RecommendationRow = Selectable<ProgressionRecommendationsTable>;

const dateOnly = (value: unknown): string =>
  value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);

/**
 * Youth development records and progression recommendations (ENR-14; SPK-YOUTH-005,
 * SPK-YOUTH-006, SPK-COMMS-002). Owner Proposed: enrollment (§4.4 names no entity). Templates,
 * scales and what families see are DEC-003 and DEC-054; what a recommendation may draw on is
 * DEC-055. A program manager authors templates; a program manager, or a coach while accepted on the
 * offering, records observations; a program manager other than the author approves them, which
 * publishes family-visible feedback or records staff-only notes. Staff notes and review notes never
 * reach a family read or notice. A recommendation never holds capacity or guarantees acceptance,
 * availability or purchase. Authoring, review and sharing need the `youth_progression` switch
 * (DEC-016); withdrawal, retirement and reads never check it.
 */
@Injectable()
export class YouthProgressionService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(OFFERING_LOOKUP_PORT) private readonly offerings: OfferingLookupPort,
    @Inject(ASSIGNMENT_COVERAGE_PORT) private readonly coverage: AssignmentCoveragePort,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly capabilities: CapabilityService,
    private readonly customers: CustomerScope,
    private readonly scope: EnrollmentFacilityScope,
    private readonly evaluator: RegistrationEvaluator,
    private readonly notifications: NotificationsService,
  ) {}

  // -------------------------------------------------------------------------------------------
  // Views
  // -------------------------------------------------------------------------------------------

  private toTemplate(row: TemplateRow): AssessmentTemplate {
    const scale = row.scale as unknown as { kind: 'ordinal'; levels: string[] };
    return {
      id: row.id,
      programId: row.program_id,
      name: row.name,
      version: row.version,
      skillAreas: row.skill_areas as unknown as Array<{ key: string; label: string }>,
      scale: { kind: 'ordinal', levels: scale.levels },
      status: row.status,
      approvedAt: isoOrNull(row.approved_at),
      retiredAt: isoOrNull(row.retired_at),
      revision: row.revision,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
    };
  }

  private toAssessment(row: AssessmentRow): Assessment {
    return {
      id: row.id,
      templateId: row.template_id,
      participantPersonId: row.participant_person_id,
      offeringId: row.offering_id,
      skillAreaKey: row.skill_area_key,
      observedOn: dateOnly(row.observed_on),
      scaleValue: row.scale_value,
      comments: row.comments,
      staffNote: row.staff_note,
      visibility: row.visibility,
      status: row.status,
      authorPersonId: row.author_person_id,
      reviewerPersonId: row.reviewer_person_id,
      reviewNote: row.review_note,
      reviewedAt: isoOrNull(row.reviewed_at),
      correctsAssessmentId: row.corrects_assessment_id,
      revision: row.revision,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
    };
  }

  private toRecommendation(row: RecommendationRow): ProgressionRecommendation {
    return {
      id: row.id,
      participantPersonId: row.participant_person_id,
      fromOfferingId: row.from_offering_id,
      recommendedOfferingId: row.recommended_offering_id,
      recommendedProgramId: row.recommended_program_id,
      eligibility: (row.eligibility_snapshot as Record<string, unknown> | null) ?? null,
      suitability: row.suitability,
      status: row.status,
      sharedAt: isoOrNull(row.shared_at),
      revision: row.revision,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
    };
  }

  // -------------------------------------------------------------------------------------------
  // Authority helpers
  // -------------------------------------------------------------------------------------------

  /** A program manager at the offering's facility (the template action names that role only). */
  private async isProgramManagerAt(
    principal: Principal,
    organizationId: string,
    facilityId: string | undefined,
  ): Promise<boolean> {
    if (!principal.staffRoles.includes('program_manager') && principal.kind !== 'system') {
      return false;
    }
    return (
      await this.authorization.decide(principal, EnrollmentActions.retireAssessmentTemplate, {
        type: 'assessment',
        organizationId,
        facilityId,
      })
    ).allowed;
  }

  /**
   * Program managers at the offering's facility, or a coach holding an accepted (or completed)
   * assignment on the offering (WRK-03, IF-34). Anyone else is refused.
   */
  private async requireOfferingAuthor(
    trx: Trx,
    principal: Principal,
    action: (typeof EnrollmentActions)[keyof typeof EnrollmentActions],
    organizationId: string,
    offeringId: string,
    subjectPersonId: string,
  ): Promise<{ facilityId: string | undefined; asProgramManager: boolean }> {
    const facilityId = await this.scope.facilityOf(organizationId, offeringId, trx);
    await this.authorization.require(principal, action, {
      type: 'assessment',
      organizationId,
      facilityId,
      subjectPersonIds: [subjectPersonId],
    });
    if (await this.isProgramManagerAt(principal, organizationId, facilityId)) {
      return { facilityId, asProgramManager: true };
    }
    if (
      principal.personId &&
      (await this.coverage.isAcceptedOnOffering(
        organizationId,
        offeringId,
        principal.personId,
        'coach',
        trx,
      ))
    ) {
      return { facilityId, asProgramManager: false };
    }
    throw errors.accessDenied(
      'Only the offering’s program managers and accepted coaches may do this.',
      {
        code: 'NOT_OFFERING_STAFF',
      },
    );
  }

  private async loadTemplate(
    trx: Trx,
    organizationId: string,
    id: string,
  ): Promise<TemplateRow | undefined> {
    return trx
      .selectFrom('assessment_templates')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
  }

  private async loadAssessment(
    trx: Trx,
    organizationId: string,
    id: string,
  ): Promise<AssessmentRow | undefined> {
    return trx
      .selectFrom('assessments')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
  }

  private async loadRecommendation(
    trx: Trx,
    organizationId: string,
    id: string,
  ): Promise<RecommendationRow | undefined> {
    return trx
      .selectFrom('progression_recommendations')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
  }

  // -------------------------------------------------------------------------------------------
  // Templates (program managers)
  // -------------------------------------------------------------------------------------------

  async createTemplate(
    principal: Principal,
    input: CreateAssessmentTemplateInput,
    correlationId: string | null,
  ): Promise<AssessmentTemplate> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      await this.authorization.require(principal, EnrollmentActions.manageAssessmentTemplate, {
        type: 'assessment_template',
        organizationId,
      });
      await this.capabilities.require(organizationId, 'youth_progression', trx);
      const id = newId();
      try {
        await trx
          .insertInto('assessment_templates')
          .values({
            id,
            organization_id: organizationId,
            program_id: input.programId,
            name: input.name,
            version: input.version,
            skill_areas: json(input.skillAreas),
            scale: json(input.scale),
            authored_by_person_id: principal.personId,
            authored_by: json(actorSnapshot(principal)),
          })
          .execute();
      } catch (error) {
        if ((error as { code?: string }).code === '23505') {
          throw errors.resourceConflict('This template version already exists.', {
            code: 'TEMPLATE_VERSION_EXISTS',
          });
        }
        if ((error as { code?: string }).code === '23503') {
          throw errors.notFound('program', input.programId);
        }
        throw error;
      }
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: EnrollmentActions.manageAssessmentTemplate.id,
        targetType: 'assessment_template',
        targetId: id,
        afterRevision: 1,
        correlationId,
        details: { programId: input.programId, name: input.name, version: input.version },
      });
      return this.toTemplate((await this.loadTemplate(trx, organizationId, id))!);
    });
  }

  async approveTemplate(
    principal: Principal,
    id: string,
    input: { expectedRevision: number },
    correlationId: string | null,
  ): Promise<AssessmentTemplate> {
    return this.templateTransition(principal, id, 'approve', input, null, correlationId);
  }

  async retireTemplate(
    principal: Principal,
    id: string,
    input: { reason: string },
    correlationId: string | null,
  ): Promise<AssessmentTemplate> {
    return this.templateTransition(principal, id, 'retire', {}, input.reason, correlationId);
  }

  private async templateTransition(
    principal: Principal,
    id: string,
    event: 'approve' | 'retire',
    input: { expectedRevision?: number },
    reason: string | null,
    correlationId: string | null,
  ): Promise<AssessmentTemplate> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const row = await this.loadTemplate(trx, organizationId, id);
      if (!row) throw errors.notFound('assessment_template', id);
      const action =
        event === 'approve'
          ? EnrollmentActions.manageAssessmentTemplate
          : EnrollmentActions.retireAssessmentTemplate;
      await this.authorization.require(principal, action, {
        type: 'assessment_template',
        id,
        organizationId,
      });
      if (event === 'approve') {
        await this.capabilities.require(organizationId, 'youth_progression', trx);
      }
      if (input.expectedRevision !== undefined) {
        assertExpectedRevision(input.expectedRevision, row.revision);
      }
      const status = AssessmentTemplateMachine.next(row.status, event);
      const now = this.clock.now();
      await trx
        .updateTable('assessment_templates')
        .set(
          event === 'approve'
            ? {
                status,
                approved_at: now,
                approved_by_person_id: principal.personId,
                revision: row.revision + 1,
              }
            : { status, retired_at: now, retired_reason: reason, revision: row.revision + 1 },
        )
        .where('organization_id', '=', organizationId)
        .where('id', '=', id)
        .where('revision', '=', row.revision)
        .execute();
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: action.id,
        targetType: 'assessment_template',
        targetId: id,
        beforeRevision: row.revision,
        afterRevision: row.revision + 1,
        reason,
        correlationId,
        details: { event, previousStatus: row.status },
      });
      return this.toTemplate((await this.loadTemplate(trx, organizationId, id))!);
    });
  }

  // -------------------------------------------------------------------------------------------
  // Assessments
  // -------------------------------------------------------------------------------------------

  async createAssessment(
    principal: Principal,
    input: CreateAssessmentInput,
    correlationId: string | null,
  ): Promise<Assessment> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      await this.requireOfferingAuthor(
        trx,
        principal,
        EnrollmentActions.authorAssessment,
        organizationId,
        input.offeringId,
        input.participantPersonId,
      );
      await this.capabilities.require(organizationId, 'youth_progression', trx);
      if (!principal.personId) throw errors.authenticationRequired();
      // An observation is of a participant of the offering (an active or finished enrollment).
      const enrolled = await trx
        .selectFrom('enrollments')
        .select('id')
        .where('organization_id', '=', organizationId)
        .where('offering_id', '=', input.offeringId)
        .where('participant_person_id', '=', input.participantPersonId)
        .where('status', 'in', ['confirmed', 'completed'])
        .executeTakeFirst();
      if (!enrolled) {
        throw errors.validation('The participant is not enrolled in this offering.', {
          code: 'NOT_A_PARTICIPANT',
          path: 'participantPersonId',
        });
      }
      if (input.correctsAssessmentId) {
        const corrected = await this.loadAssessment(
          trx,
          organizationId,
          input.correctsAssessmentId,
        );
        if (
          !corrected ||
          corrected.participant_person_id !== input.participantPersonId ||
          !['published', 'recorded'].includes(corrected.status)
        ) {
          throw errors.validation('Only a published or recorded assessment is corrected.', {
            path: 'correctsAssessmentId',
          });
        }
      }
      const id = newId();
      await trx
        .insertInto('assessments')
        .values({
          id,
          organization_id: organizationId,
          template_id: input.templateId,
          participant_person_id: input.participantPersonId,
          offering_id: input.offeringId,
          skill_area_key: input.skillAreaKey,
          observed_on: input.observedOn,
          scale_value: input.scaleValue,
          comments: input.comments ?? null,
          staff_note: input.staffNote ?? null,
          visibility: input.visibility,
          author_person_id: principal.personId,
          author: json(actorSnapshot(principal)),
          corrects_assessment_id: input.correctsAssessmentId ?? null,
        })
        .execute()
        .catch((error: unknown) => {
          if ((error as { code?: string }).code === '23514') {
            throw errors.validation(
              'The assessment must use an approved template, one of its skill areas and a value on its scale.',
              { code: 'TEMPLATE_MISMATCH' },
            );
          }
          throw error;
        });
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: EnrollmentActions.authorAssessment.id,
        targetType: 'assessment',
        targetId: id,
        afterRevision: 1,
        correlationId,
        details: {
          templateId: input.templateId,
          offeringId: input.offeringId,
          visibility: input.visibility,
        },
      });
      return this.toAssessment((await this.loadAssessment(trx, organizationId, id))!);
    });
  }

  async updateAssessment(
    principal: Principal,
    id: string,
    input: UpdateAssessmentInput,
    correlationId: string | null,
  ): Promise<Assessment> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const row = await this.loadAssessment(trx, organizationId, id);
      if (!row) throw errors.protectedNotFound('assessment');
      await this.requireOfferingAuthor(
        trx,
        principal,
        EnrollmentActions.authorAssessment,
        organizationId,
        row.offering_id,
        row.participant_person_id,
      );
      await this.capabilities.require(organizationId, 'youth_progression', trx);
      if (row.author_person_id !== principal.personId) {
        throw errors.accessDenied('Only the author edits an assessment.', { code: 'NOT_AUTHOR' });
      }
      assertExpectedRevision(input.expectedRevision, row.revision);
      if (row.status !== 'draft' && row.status !== 'returned') {
        throw errors.invalidTransition('Assessment', row.status, 'edit');
      }
      await trx
        .updateTable('assessments')
        .set({
          skill_area_key: input.skillAreaKey ?? row.skill_area_key,
          observed_on: input.observedOn ?? dateOnly(row.observed_on),
          scale_value: input.scaleValue ?? row.scale_value,
          comments: input.comments === undefined ? row.comments : input.comments,
          staff_note: input.staffNote === undefined ? row.staff_note : input.staffNote,
          visibility: input.visibility ?? row.visibility,
          revision: row.revision + 1,
        })
        .where('organization_id', '=', organizationId)
        .where('id', '=', id)
        .where('revision', '=', row.revision)
        .execute();
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: EnrollmentActions.authorAssessment.id,
        targetType: 'assessment',
        targetId: id,
        beforeRevision: row.revision,
        afterRevision: row.revision + 1,
        correlationId,
        details: { edited: Object.keys(input).filter((k) => k !== 'expectedRevision') },
      });
      return this.toAssessment((await this.loadAssessment(trx, organizationId, id))!);
    });
  }

  async submitAssessment(
    principal: Principal,
    id: string,
    input: { expectedRevision: number },
    correlationId: string | null,
  ): Promise<Assessment> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const row = await this.loadAssessment(trx, organizationId, id);
      if (!row) throw errors.protectedNotFound('assessment');
      await this.requireOfferingAuthor(
        trx,
        principal,
        EnrollmentActions.authorAssessment,
        organizationId,
        row.offering_id,
        row.participant_person_id,
      );
      await this.capabilities.require(organizationId, 'youth_progression', trx);
      if (row.author_person_id !== principal.personId) {
        throw errors.accessDenied('Only the author submits an assessment.', { code: 'NOT_AUTHOR' });
      }
      assertExpectedRevision(input.expectedRevision, row.revision);
      const event: AssessmentEvent = row.status === 'returned' ? 'resubmit' : 'submit';
      return this.assessmentTransition(trx, principal, row, event, {}, null, correlationId);
    });
  }

  async withdrawAssessment(
    principal: Principal,
    id: string,
    input: { reason: string; expectedRevision: number },
    correlationId: string | null,
  ): Promise<Assessment> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const row = await this.loadAssessment(trx, organizationId, id);
      if (!row) throw errors.protectedNotFound('assessment');
      const author = await this.requireOfferingAuthor(
        trx,
        principal,
        EnrollmentActions.withdrawAssessment,
        organizationId,
        row.offering_id,
        row.participant_person_id,
      );
      if (!author.asProgramManager && row.author_person_id !== principal.personId) {
        throw errors.accessDenied('Only the author or a program manager withdraws it.', {
          code: 'NOT_AUTHOR',
        });
      }
      assertExpectedRevision(input.expectedRevision, row.revision);
      return this.assessmentTransition(
        trx,
        principal,
        row,
        'withdraw',
        { withdrawn_at: this.clock.now(), withdrawn_reason: input.reason },
        input.reason,
        correlationId,
      );
    });
  }

  async reviewAssessment(
    principal: Principal,
    id: string,
    input: ReviewAssessmentInput,
    correlationId: string | null,
  ): Promise<Assessment> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const row = await this.loadAssessment(trx, organizationId, id);
      if (!row) throw errors.protectedNotFound('assessment');
      const facilityId = await this.scope.facilityOf(organizationId, row.offering_id, trx);
      await this.authorization.require(principal, EnrollmentActions.reviewAssessment, {
        type: 'assessment',
        id,
        organizationId,
        facilityId,
      });
      await this.capabilities.require(organizationId, 'youth_progression', trx);
      // SPK-YOUTH-005: a program manager other than the author (the database also refuses it).
      if (row.author_person_id === principal.personId) {
        throw errors.accessDenied('The author cannot review their own assessment.', {
          code: 'REVIEWER_IS_AUTHOR',
        });
      }
      assertExpectedRevision(input.expectedRevision, row.revision);
      const event: AssessmentEvent =
        input.decision === 'return'
          ? 'return'
          : row.visibility === 'family'
            ? 'approve_family'
            : 'approve_internal';
      const updated = await this.assessmentTransition(
        trx,
        principal,
        row,
        event,
        {
          reviewer_person_id: principal.personId,
          review_note: input.note ?? null,
          reviewed_at: this.clock.now(),
        },
        input.note ?? null,
        correlationId,
      );
      if (event === 'approve_family') {
        await this.outbox.enqueue(trx, EnrollmentPackageGEvents.assessmentPublished, {
          organizationId,
          aggregateType: 'assessment',
          aggregateId: id,
          correlationId,
          payload: { assessmentId: id, participantPersonId: row.participant_person_id },
        });
      }
      return updated;
    });
  }

  private async assessmentTransition(
    trx: Trx,
    principal: Principal,
    row: AssessmentRow,
    event: AssessmentEvent,
    extra: Partial<{
      withdrawn_at: Date;
      withdrawn_reason: string;
      reviewer_person_id: string | null;
      review_note: string | null;
      reviewed_at: Date;
    }>,
    reason: string | null,
    correlationId: string | null,
  ): Promise<Assessment> {
    const status = AssessmentMachine.next(row.status, event);
    await trx
      .updateTable('assessments')
      .set({
        status,
        ...extra,
        ...(event === 'submit' || event === 'resubmit' ? { submitted_at: this.clock.now() } : {}),
        revision: row.revision + 1,
      })
      .where('organization_id', '=', row.organization_id)
      .where('id', '=', row.id)
      .where('revision', '=', row.revision)
      .execute();
    await this.audit.record(trx, {
      organizationId: row.organization_id,
      actor: principal,
      action: `enrollment.assessment_${event}`,
      targetType: 'assessment',
      targetId: row.id,
      beforeRevision: row.revision,
      afterRevision: row.revision + 1,
      reason,
      correlationId,
      details: { previousStatus: row.status, status },
    });
    return this.toAssessment((await this.loadAssessment(trx, row.organization_id, row.id))!);
  }

  // -------------------------------------------------------------------------------------------
  // Progression recommendations
  // -------------------------------------------------------------------------------------------

  async createRecommendation(
    principal: Principal,
    input: CreateProgressionRecommendationInput,
    correlationId: string | null,
  ): Promise<ProgressionRecommendation> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      await this.requireOfferingAuthor(
        trx,
        principal,
        EnrollmentActions.recommendProgression,
        organizationId,
        input.fromOfferingId,
        input.participantPersonId,
      );
      await this.capabilities.require(organizationId, 'youth_progression', trx);
      if (!principal.personId) throw errors.authenticationRequired();
      // DEC-055: the recommendation carries the read-only evaluation (unknown kept unknown); it
      // reserves nothing and promises nothing.
      let eligibility: Record<string, unknown> | null = null;
      if (input.recommendedOfferingId) {
        const snapshot = await this.evaluator.snapshot(
          trx,
          organizationId,
          input.recommendedOfferingId,
        );
        const person = await this.evaluator.participant(
          trx,
          organizationId,
          input.participantPersonId,
        );
        const evaluation = await this.evaluator.evaluate(trx, organizationId, {
          snapshot,
          person,
          intent: 'youth',
        });
        eligibility = evaluation.result as unknown as Record<string, unknown>;
      }
      const id = newId();
      await trx
        .insertInto('progression_recommendations')
        .values({
          id,
          organization_id: organizationId,
          participant_person_id: input.participantPersonId,
          from_offering_id: input.fromOfferingId,
          recommended_offering_id: input.recommendedOfferingId ?? null,
          recommended_program_id: input.recommendedProgramId ?? null,
          eligibility_snapshot: eligibility ? json(eligibility) : null,
          suitability: input.suitability,
          author_person_id: principal.personId,
          author: json(actorSnapshot(principal)),
        })
        .execute();
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: EnrollmentActions.recommendProgression.id,
        targetType: 'progression_recommendation',
        targetId: id,
        afterRevision: 1,
        correlationId,
        details: {
          fromOfferingId: input.fromOfferingId,
          recommendedOfferingId: input.recommendedOfferingId ?? null,
          recommendedProgramId: input.recommendedProgramId ?? null,
        },
      });
      return this.toRecommendation((await this.loadRecommendation(trx, organizationId, id))!);
    });
  }

  async shareRecommendation(
    principal: Principal,
    id: string,
    input: { expectedRevision: number },
    correlationId: string | null,
  ): Promise<ProgressionRecommendation> {
    return this.recommendationTransition(principal, id, 'share', input, null, correlationId);
  }

  async withdrawRecommendation(
    principal: Principal,
    id: string,
    input: { reason: string },
    correlationId: string | null,
  ): Promise<ProgressionRecommendation> {
    return this.recommendationTransition(
      principal,
      id,
      'withdraw',
      {},
      input.reason,
      correlationId,
    );
  }

  private async recommendationTransition(
    principal: Principal,
    id: string,
    event: 'share' | 'withdraw',
    input: { expectedRevision?: number },
    reason: string | null,
    correlationId: string | null,
  ): Promise<ProgressionRecommendation> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const row = await this.loadRecommendation(trx, organizationId, id);
      if (!row) throw errors.protectedNotFound('progression_recommendation');
      await this.requireOfferingAuthor(
        trx,
        principal,
        event === 'share'
          ? EnrollmentActions.recommendProgression
          : EnrollmentActions.withdrawRecommendation,
        organizationId,
        row.from_offering_id,
        row.participant_person_id,
      );
      if (event === 'share') {
        await this.capabilities.require(organizationId, 'youth_progression', trx);
      }
      if (input.expectedRevision !== undefined) {
        assertExpectedRevision(input.expectedRevision, row.revision);
      }
      const status = ProgressionRecommendationMachine.next(row.status, event);
      const now = this.clock.now();
      await trx
        .updateTable('progression_recommendations')
        .set(
          event === 'share'
            ? { status, shared_at: now, revision: row.revision + 1 }
            : { status, withdrawn_at: now, withdrawn_reason: reason, revision: row.revision + 1 },
        )
        .where('organization_id', '=', organizationId)
        .where('id', '=', id)
        .where('revision', '=', row.revision)
        .execute();
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action:
          event === 'share'
            ? EnrollmentActions.recommendProgression.id
            : EnrollmentActions.withdrawRecommendation.id,
        targetType: 'progression_recommendation',
        targetId: id,
        beforeRevision: row.revision,
        afterRevision: row.revision + 1,
        reason,
        correlationId,
        details: { event, previousStatus: row.status },
      });
      if (event === 'share') {
        await this.outbox.enqueue(trx, EnrollmentPackageGEvents.recommendationShared, {
          organizationId,
          aggregateType: 'progression_recommendation',
          aggregateId: id,
          correlationId,
          payload: { recommendationId: id, participantPersonId: row.participant_person_id },
        });
      }
      return this.toRecommendation((await this.loadRecommendation(trx, organizationId, id))!);
    });
  }

  // -------------------------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------------------------

  /** GET /me/youth-feedback: published family feedback and shared recommendations only. */
  async myFeedback(principal: Principal): Promise<YouthFeedback> {
    const organizationId = organizationOf(principal);
    const subjects = await this.customers.subjectIds(
      principal,
      EnrollmentActions.readYouthFeedback,
    );
    if (subjects.length === 0) return { assessments: [], recommendations: [] };
    const rows = await this.db
      .selectFrom('assessments')
      .innerJoin('assessment_templates', (join) =>
        join
          .onRef('assessment_templates.organization_id', '=', 'assessments.organization_id')
          .onRef('assessment_templates.id', '=', 'assessments.template_id'),
      )
      .select([
        'assessments.id',
        'assessments.participant_person_id',
        'assessments.offering_id',
        'assessments.skill_area_key',
        'assessments.observed_on',
        'assessments.scale_value',
        'assessments.comments',
        'assessments.reviewed_at',
        'assessment_templates.skill_areas',
        'assessment_templates.scale',
      ])
      .where('assessments.organization_id', '=', organizationId)
      .where('assessments.participant_person_id', 'in', subjects)
      .where('assessments.status', '=', 'published')
      .where('assessments.visibility', '=', 'family')
      .orderBy('assessments.observed_on', 'desc')
      .orderBy('assessments.id', 'desc')
      .limit(200)
      .execute();
    const names = new Map<string, string | null>();
    for (const offeringId of new Set(rows.map((r) => r.offering_id))) {
      const snapshot = await this.offerings.getOffering(
        organizationId,
        offeringId,
        this.clock.now(),
      );
      names.set(offeringId, snapshot?.offering.name ?? null);
    }
    const recommendations = await this.db
      .selectFrom('progression_recommendations')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('participant_person_id', 'in', subjects)
      .where('status', '=', 'shared')
      .orderBy('shared_at', 'desc')
      .orderBy('id', 'desc')
      .limit(200)
      .execute();
    return {
      assessments: rows.map((r) => {
        const areas = r.skill_areas as unknown as Array<{ key: string; label: string }>;
        const levels = (r.scale as unknown as { levels: string[] }).levels;
        return {
          id: r.id,
          participantPersonId: r.participant_person_id,
          offeringId: r.offering_id,
          offeringName: names.get(r.offering_id) ?? null,
          skillArea: {
            key: r.skill_area_key,
            label: areas.find((a) => a.key === r.skill_area_key)?.label ?? null,
          },
          observedOn: dateOnly(r.observed_on),
          scaleValue: r.scale_value,
          scaleLabel: levels[r.scale_value - 1] ?? null,
          scaleLevels: levels.length,
          comments: r.comments,
          publishedAt: iso(r.reviewed_at as Date),
        };
      }),
      recommendations: recommendations.map((r) => ({
        id: r.id,
        participantPersonId: r.participant_person_id,
        fromOfferingId: r.from_offering_id,
        recommendedOfferingId: r.recommended_offering_id,
        recommendedProgramId: r.recommended_program_id,
        suitability: r.suitability,
        sharedAt: iso(r.shared_at as Date),
      })),
    };
  }

  /**
   * GET /participants/{personId}/assessments (staff view): program managers see the assessments of
   * offerings in their facility scope; a coach sees those of offerings they hold an accepted or
   * completed assignment on (others' submitted and later rows, their own drafts); anyone else
   * learns nothing.
   */
  async participantAssessments(
    principal: Principal,
    personId: string,
    query: ParticipantAssessmentsQuery,
  ): Promise<Page<Assessment>> {
    const organizationId = organizationOf(principal);
    // A staff view: program managers and coaches only; everyone else learns nothing (§4.10).
    if (
      principal.kind !== 'staff' ||
      !EnrollmentActions.readAssessments.staffRoles.some((role) =>
        principal.staffRoles.includes(role),
      )
    ) {
      throw errors.protectedNotFound('participant');
    }
    const candidates = await this.db
      .selectFrom('assessments')
      .select('offering_id')
      .distinct()
      .where('organization_id', '=', organizationId)
      .where('participant_person_id', '=', personId)
      .execute();
    const managed: string[] = [];
    const coached: string[] = [];
    for (const { offering_id: offeringId } of candidates) {
      if (query.offeringId && query.offeringId !== offeringId) continue;
      const facilityId = await this.scope.facilityOf(organizationId, offeringId);
      if (await this.isProgramManagerAt(principal, organizationId, facilityId)) {
        managed.push(offeringId);
      } else if (
        principal.personId &&
        (await this.coverage.isAcceptedOnOffering(
          organizationId,
          offeringId,
          principal.personId,
          'coach',
        ))
      ) {
        coached.push(offeringId);
      }
    }
    if (managed.length === 0 && coached.length === 0) {
      // §4.10: the answer never depends on rows outside the caller's scope. A program manager
      // gets an empty page whether the person has no assessments at all or only at another
      // facility's offerings; a coach with nothing visible gets NOT_FOUND in both cases.
      if (principal.staffRoles.includes('program_manager')) {
        return { items: [], nextCursor: null };
      }
      throw errors.protectedNotFound('participant');
    }
    const cursor = decodeCreatedCursor(query.cursor);
    let q = this.db
      .selectFrom('assessments')
      .selectAll()
      .select(cursorAt('assessments').as('cursor_at'))
      .where('organization_id', '=', organizationId)
      .where('participant_person_id', '=', personId)
      .where((eb) => {
        const branches = [];
        if (managed.length > 0) branches.push(eb('offering_id', 'in', managed));
        if (coached.length > 0) {
          branches.push(
            eb.and([
              eb('offering_id', 'in', coached),
              eb.or([
                eb('author_person_id', '=', principal.personId as string),
                eb('status', 'in', ['submitted', 'returned', 'published', 'recorded']),
              ]),
            ]),
          );
        }
        return eb.or(branches);
      })
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(query.limit + 1);
    if (cursor) q = q.where(beforeCursor('assessments', cursor));
    const page = keysetPage(await q.execute(), query.limit);
    return { items: page.rows.map((r) => this.toAssessment(r)), nextCursor: page.nextCursor };
  }

  // -------------------------------------------------------------------------------------------
  // Notices (handlers; IF-22): one youth_feedback notice per event, with no staff content
  // -------------------------------------------------------------------------------------------

  async notifyAssessmentPublished(
    trx: Trx,
    event: DomainEvent<{ assessmentId: string; participantPersonId: string }>,
  ): Promise<void> {
    const row = await trx
      .selectFrom('assessments')
      .select(['offering_id', 'status', 'visibility'])
      .where('organization_id', '=', event.organizationId)
      .where('id', '=', event.payload.assessmentId)
      .executeTakeFirst();
    if (!row || row.status !== 'published' || row.visibility !== 'family') return;
    const snapshot = await this.offerings.getOffering(
      event.organizationId,
      row.offering_id,
      this.clock.now(),
      trx,
    );
    await this.notifications.composeAndQueueIn(
      trx,
      enrollmentSystem(event.organizationId, 'enrollment.notify_youth_feedback'),
      {
        kind: 'youth_feedback',
        facilityId: snapshot?.offering.facilityId,
        subject: { type: 'assessment', id: event.payload.assessmentId },
        audience: { subjectPersonIds: [event.payload.participantPersonId] },
        protected: true,
        title: 'New feedback',
        body: `New feedback from ${snapshot?.offering.name ?? 'the program'} is available in the app.`,
        sourceEventId: event.id,
        correlationId: event.correlationId,
      },
    );
  }

  async notifyRecommendationShared(
    trx: Trx,
    event: DomainEvent<{ recommendationId: string; participantPersonId: string }>,
  ): Promise<void> {
    const row = await trx
      .selectFrom('progression_recommendations')
      .select(['from_offering_id', 'status'])
      .where('organization_id', '=', event.organizationId)
      .where('id', '=', event.payload.recommendationId)
      .executeTakeFirst();
    if (!row || row.status !== 'shared') return;
    const snapshot = await this.offerings.getOffering(
      event.organizationId,
      row.from_offering_id,
      this.clock.now(),
      trx,
    );
    await this.notifications.composeAndQueueIn(
      trx,
      enrollmentSystem(event.organizationId, 'enrollment.notify_youth_feedback'),
      {
        kind: 'youth_feedback',
        facilityId: snapshot?.offering.facilityId,
        subject: { type: 'progression_recommendation', id: event.payload.recommendationId },
        audience: { subjectPersonIds: [event.payload.participantPersonId] },
        protected: true,
        title: 'A next step is suggested',
        body: 'A suggestion for the next program is available in the app. It does not reserve a place.',
        sourceEventId: event.id,
        correlationId: event.correlationId,
      },
    );
  }
}
