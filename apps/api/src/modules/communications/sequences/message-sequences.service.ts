import { Inject, Injectable } from '@nestjs/common';
import {
  MESSAGE_ANCHORS_BY_SUBJECT,
  errors,
  newId,
  type AddMessageSequenceStepInput,
  type CreateMessageSequenceInput,
  type ListMessageSequencesQuery,
  type MessageAnchor,
  type MessageSequence,
  type MessageSequenceList,
  type MessageSubjectType,
  type Principal,
  type RemoveMessageSequenceStepInput,
  type UpdateMessageSequenceInput,
  type UpdateMessageSequenceStepInput,
} from '@sportspark/contracts';
import { json, type Db } from '@sportspark/db';
import {
  AuditWriter,
  AuthorizationService,
  CLOCK,
  CapabilityService,
  FacilityDirectory,
  UnitOfWork,
  assertExpectedRevision,
  databaseConstraintOf,
  ensureUpdated,
  listFacilityScope,
  snapshotActor,
  type Clock,
  type Trx,
} from '../../../kernel';
import { CommunicationsActions } from '../communications.actions';
import { organizationOf } from '../communications.shared';
import { MessageScheduleService } from './message-schedule.service';
import { MESSAGE_SEQUENCE_POLICY, type MessageSequencePolicy } from './message-sequences.policy';
import {
  loadSteps,
  toSequence,
  toStep,
  type SequenceRow,
  type StepRow,
} from './message-sequences.shared';

const NAME_INDEX = 'message_sequences_name_idx';

/**
 * Message sequences and their steps (SPK-COMMS-009, proposed amendment PA-05; capability
 * `message_sequences`). A sequence is for seasons or for offerings, belongs to one facility (whose
 * local time its steps are read in and whose staff manage it), may be limited to one competition
 * or program, and produces schedules only while it is active. A step is a template and a number
 * of days before or after an anchor date. Changing a step moves its unsent messages; removing one
 * cancels them. What was sent never changes.
 */
@Injectable()
export class MessageSequencesService {
  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(MESSAGE_SEQUENCE_POLICY) private readonly policy: MessageSequencePolicy,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly capabilities: CapabilityService,
    private readonly facilities: FacilityDirectory,
    private readonly schedule: MessageScheduleService,
  ) {}

  async list(principal: Principal, query: ListMessageSequencesQuery): Promise<MessageSequenceList> {
    const organizationId = organizationOf(principal);
    await this.authorization.require(principal, CommunicationsActions.readMessageSchedule, {
      type: 'message_sequence',
      organizationId,
      facilityId: query.facilityId ?? null,
    });
    const reader = this.uow.reader();
    let q = reader
      .selectFrom('message_sequences')
      .selectAll()
      .where('organization_id', '=', organizationId);
    if (query.facilityId) q = q.where('facility_id', '=', query.facilityId);
    if (query.subjectType) q = q.where('subject_type', '=', query.subjectType);
    // §4.14: a facility-scoped reader lists the sequences of their facilities only.
    const scope = listFacilityScope(principal, CommunicationsActions.readMessageSchedule);
    if (scope) {
      if (scope.length === 0) return { items: [] };
      q = q.where('facility_id', 'in', [...scope]);
    }
    const rows = await q.orderBy('name').orderBy('id').execute();
    const steps = await loadSteps(
      reader,
      organizationId,
      rows.map((r) => r.id),
    );
    return {
      items: rows.map((row) =>
        toSequence(
          row,
          steps.filter((s) => s.sequence_id === row.id).map((s) => toStep(s, this.policy)),
        ),
      ),
    };
  }

  async get(principal: Principal, id: string): Promise<MessageSequence> {
    const organizationId = organizationOf(principal);
    const reader = this.uow.reader();
    const row = await this.load(reader, organizationId, id);
    if (!row) throw errors.notFound('message_sequence', id);
    await this.authorization.require(principal, CommunicationsActions.readMessageSchedule, {
      type: 'message_sequence',
      id,
      organizationId,
      facilityId: row.facility_id,
    });
    return this.view(reader, row);
  }

  async create(
    principal: Principal,
    input: CreateMessageSequenceInput,
    correlationId: string | null,
  ): Promise<MessageSequence> {
    const organizationId = organizationOf(principal);
    const id = newId();
    return this.uow.run(async ({ trx }) => {
      await this.authorization.require(principal, CommunicationsActions.manageMessageSequences, {
        type: 'message_sequence',
        organizationId,
        facilityId: input.facilityId,
      });
      await this.capabilities.require(organizationId, 'message_sequences', trx);
      const facility = (
        await this.facilities.describe(organizationId, [input.facilityId], trx)
      ).get(input.facilityId);
      if (!facility) throw errors.notFound('facility', input.facilityId);
      await this.namedOnce(() =>
        this.uow.run(({ trx: inner }) =>
          inner
            .insertInto('message_sequences')
            .values({
              id,
              organization_id: organizationId,
              facility_id: input.facilityId,
              name: input.name,
              subject_type: input.subjectType,
              scope_id: input.scopeId ?? null,
              active: false,
              created_by: json(snapshotActor(principal)),
            })
            .execute(),
        ),
      );
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: CommunicationsActions.manageMessageSequences.id,
        targetType: 'message_sequence',
        targetId: id,
        afterRevision: 1,
        reason: input.reason ?? null,
        correlationId,
        details: {
          operation: 'create',
          subjectType: input.subjectType,
          scopeId: input.scopeId ?? null,
          facilityId: input.facilityId,
        },
      });
      return this.view(trx, await this.loadOrThrow(trx, organizationId, id));
    });
  }

  async update(
    principal: Principal,
    id: string,
    input: UpdateMessageSequenceInput,
    correlationId: string | null,
  ): Promise<MessageSequence> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const current = await this.lock(trx, principal, organizationId, id);
      assertExpectedRevision(input.expectedRevision, current.revision);
      const next = {
        name: input.name ?? current.name,
        scope_id: input.scopeId === undefined ? current.scope_id : input.scopeId,
        active: input.active ?? current.active,
      };
      await this.namedOnce(() =>
        this.uow.run(async ({ trx: inner }) => {
          const result = await inner
            .updateTable('message_sequences')
            .set({ ...next, revision: current.revision + 1 })
            .where('organization_id', '=', organizationId)
            .where('id', '=', id)
            .where('revision', '=', current.revision)
            .executeTakeFirst();
          ensureUpdated(result.numUpdatedRows, () =>
            errors.staleRevision(current.revision, current.revision + 1),
          );
        }),
      );
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: CommunicationsActions.manageMessageSequences.id,
        targetType: 'message_sequence',
        targetId: id,
        beforeRevision: current.revision,
        afterRevision: current.revision + 1,
        reason: input.reason ?? null,
        correlationId,
        details: {
          operation: 'update',
          active: next.active,
          previousActive: current.active,
          scopeId: next.scope_id,
        },
      });
      return this.view(trx, await this.loadOrThrow(trx, organizationId, id));
    });
  }

  async addStep(
    principal: Principal,
    sequenceId: string,
    input: AddMessageSequenceStepInput,
    correlationId: string | null,
  ): Promise<MessageSequence> {
    const organizationId = organizationOf(principal);
    const stepId = newId();
    return this.uow.run(async ({ trx }) => {
      const sequence = await this.lock(trx, principal, organizationId, sequenceId);
      this.assertAnchor(sequence.subject_type, input.anchor);
      await this.assertTemplate(trx, organizationId, input.templateId);
      const last = await trx
        .selectFrom('message_sequence_steps')
        .select(({ fn }) => fn.max('position').as('position'))
        .where('organization_id', '=', organizationId)
        .where('sequence_id', '=', sequenceId)
        .where('retired_at', 'is', null)
        .executeTakeFirst();
      await trx
        .insertInto('message_sequence_steps')
        .values({
          id: stepId,
          organization_id: organizationId,
          sequence_id: sequenceId,
          template_id: input.templateId,
          position: input.position ?? Number(last?.position ?? 0) + 1,
          anchor: input.anchor,
          offset_days: input.offsetDays,
          send_time_local: input.sendTimeLocal ?? null,
          retired_at: null,
        })
        .execute();
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: CommunicationsActions.manageMessageSequences.id,
        targetType: 'message_sequence_step',
        targetId: stepId,
        afterRevision: 1,
        reason: input.reason ?? null,
        correlationId,
        details: {
          operation: 'add_step',
          sequenceId,
          templateId: input.templateId,
          anchor: input.anchor,
          offsetDays: input.offsetDays,
          sendTimeLocal: input.sendTimeLocal ?? null,
        },
      });
      return this.view(trx, sequence);
    });
  }

  /** Changes a step; its unsent messages follow (a confirmed one needs confirming again). */
  async updateStep(
    principal: Principal,
    sequenceId: string,
    stepId: string,
    input: UpdateMessageSequenceStepInput,
    correlationId: string | null,
  ): Promise<MessageSequence> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const sequence = await this.lock(trx, principal, organizationId, sequenceId);
      const step = await this.lockStep(trx, organizationId, sequenceId, stepId);
      assertExpectedRevision(input.expectedRevision, step.revision);
      const anchor = input.anchor ?? step.anchor;
      this.assertAnchor(sequence.subject_type, anchor);
      if (input.templateId && input.templateId !== step.template_id) {
        await this.assertTemplate(trx, organizationId, input.templateId);
      }
      const result = await trx
        .updateTable('message_sequence_steps')
        .set({
          template_id: input.templateId ?? step.template_id,
          anchor,
          offset_days: input.offsetDays ?? step.offset_days,
          send_time_local:
            input.sendTimeLocal === undefined ? step.send_time_local : input.sendTimeLocal,
          position: input.position ?? step.position,
          revision: step.revision + 1,
        })
        .where('organization_id', '=', organizationId)
        .where('id', '=', stepId)
        .where('revision', '=', step.revision)
        .executeTakeFirst();
      ensureUpdated(result.numUpdatedRows, () =>
        errors.staleRevision(step.revision, step.revision + 1),
      );
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: CommunicationsActions.manageMessageSequences.id,
        targetType: 'message_sequence_step',
        targetId: stepId,
        beforeRevision: step.revision,
        afterRevision: step.revision + 1,
        reason: input.reason ?? null,
        correlationId,
        details: {
          operation: 'update_step',
          sequenceId,
          fields: Object.keys(input).filter((k) => k !== 'expectedRevision' && k !== 'reason'),
        },
      });
      await this.schedule.followStep(trx, principal, organizationId, stepId, correlationId);
      return this.view(trx, sequence);
    });
  }

  /** Removes a step: it produces nothing more and its unsent messages are canceled. */
  async removeStep(
    principal: Principal,
    sequenceId: string,
    stepId: string,
    input: RemoveMessageSequenceStepInput,
    correlationId: string | null,
  ): Promise<MessageSequence> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const sequence = await this.lock(trx, principal, organizationId, sequenceId, {
        // Removing creates nothing: it stays possible while the switch is off.
        capability: false,
      });
      const step = await this.lockStep(trx, organizationId, sequenceId, stepId);
      assertExpectedRevision(input.expectedRevision, step.revision);
      const result = await trx
        .updateTable('message_sequence_steps')
        .set({ retired_at: this.clock.now(), revision: step.revision + 1 })
        .where('organization_id', '=', organizationId)
        .where('id', '=', stepId)
        .where('revision', '=', step.revision)
        .executeTakeFirst();
      ensureUpdated(result.numUpdatedRows, () =>
        errors.staleRevision(step.revision, step.revision + 1),
      );
      const canceled = await this.schedule.cancelForStep(
        trx,
        principal,
        organizationId,
        stepId,
        correlationId,
      );
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: CommunicationsActions.manageMessageSequences.id,
        targetType: 'message_sequence_step',
        targetId: stepId,
        beforeRevision: step.revision,
        afterRevision: step.revision + 1,
        reason: input.reason ?? null,
        correlationId,
        details: { operation: 'remove_step', sequenceId, canceledMessages: canceled },
      });
      return this.view(trx, sequence);
    });
  }

  // -------------------------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------------------------
  /** Locks the sequence, authorizes the manager at its facility and checks the switch. */
  private async lock(
    trx: Trx,
    principal: Principal,
    organizationId: string,
    id: string,
    options: { capability: boolean } = { capability: true },
  ): Promise<SequenceRow> {
    const row = await trx
      .selectFrom('message_sequences')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
    if (!row) throw errors.notFound('message_sequence', id);
    await this.authorization.require(principal, CommunicationsActions.manageMessageSequences, {
      type: 'message_sequence',
      id,
      organizationId,
      facilityId: row.facility_id,
    });
    if (options.capability) {
      await this.capabilities.require(organizationId, 'message_sequences', trx);
    }
    return row;
  }

  private async lockStep(
    trx: Trx,
    organizationId: string,
    sequenceId: string,
    stepId: string,
  ): Promise<StepRow> {
    const step = await trx
      .selectFrom('message_sequence_steps')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('sequence_id', '=', sequenceId)
      .where('id', '=', stepId)
      .forUpdate()
      .executeTakeFirst();
    if (!step) throw errors.notFound('message_sequence_step', stepId);
    if (step.retired_at !== null) {
      throw errors.resourceConflict('This step was removed and cannot be changed.', {
        code: 'STEP_REMOVED',
      });
    }
    return step;
  }

  private assertAnchor(subjectType: MessageSubjectType, anchor: MessageAnchor): void {
    if (MESSAGE_ANCHORS_BY_SUBJECT[subjectType].includes(anchor)) return;
    throw errors.validation(
      `A sequence for ${subjectType}s cannot count from "${anchor.replaceAll('_', ' ')}".`,
      {
        code: 'ANCHOR_NOT_AVAILABLE',
        path: 'anchor',
        allowed: MESSAGE_ANCHORS_BY_SUBJECT[subjectType],
      },
    );
  }

  private async assertTemplate(trx: Trx, organizationId: string, templateId: string) {
    const template = await trx
      .selectFrom('message_templates')
      .select(['id', 'status'])
      .where('organization_id', '=', organizationId)
      .where('id', '=', templateId)
      .executeTakeFirst();
    if (!template) throw errors.notFound('message_template', templateId);
    if (template.status !== 'active') {
      throw errors.validation('An archived template cannot be used in a step.', {
        code: 'TEMPLATE_ARCHIVED',
        path: 'templateId',
      });
    }
  }

  private async view(db: Db | Trx, row: SequenceRow): Promise<MessageSequence> {
    const current = await this.loadOrThrow(db, row.organization_id, row.id);
    const steps = await loadSteps(db, row.organization_id, [row.id]);
    return toSequence(
      current,
      steps.map((s) => toStep(s, this.policy)),
    );
  }

  private async load(
    db: Db | Trx,
    organizationId: string,
    id: string,
  ): Promise<SequenceRow | null> {
    const row = await db
      .selectFrom('message_sequences')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', id)
      .executeTakeFirst();
    return row ?? null;
  }

  private async loadOrThrow(db: Db | Trx, organizationId: string, id: string) {
    const row = await this.load(db, organizationId, id);
    if (!row) throw errors.notFound('message_sequence', id);
    return row;
  }

  /** One sequence per name at a facility: the database's answer becomes RESOURCE_CONFLICT. */
  private async namedOnce(write: () => Promise<unknown>): Promise<void> {
    try {
      await write();
    } catch (error) {
      const violation = databaseConstraintOf(error);
      if (violation?.code === '23505' && violation.constraint === NAME_INDEX) {
        throw errors.resourceConflict(
          'A sequence with this name already exists at this facility.',
          { code: 'SEQUENCE_NAME_TAKEN' },
        );
      }
      throw error;
    }
  }
}
