import { Injectable } from '@nestjs/common';
import {
  MESSAGE_PLACEHOLDERS,
  MESSAGE_PLACEHOLDER_NAMES,
  errors,
  newId,
  type CreateMessageTemplateInput,
  type ListMessageTemplatesQuery,
  type MessagePlaceholderList,
  type MessageTemplate,
  type MessageTemplateList,
  type Principal,
  type UpdateMessageTemplateInput,
} from '@sportspark/contracts';
import { json } from '@sportspark/db';
import {
  AuditWriter,
  AuthorizationService,
  CapabilityService,
  UnitOfWork,
  assertExpectedRevision,
  databaseConstraintOf,
  ensureUpdated,
  snapshotActor,
} from '../../../kernel';
import { CommunicationsActions } from '../communications.actions';
import { organizationOf } from '../communications.shared';
import { MessageScheduleService } from './message-schedule.service';
import { toTemplate } from './message-sequences.shared';

const NAME_INDEX = 'message_templates_active_name_idx';

/**
 * Reusable message templates (SPK-COMMS-009, proposed amendment PA-05; capability
 * `message_sequences`). A template is a title and a body with named placeholders, essential or
 * promotional (SPK-COMMS-007), versioned by its revision. Changing one never changes what was
 * sent, nor an edited copy kept for one message; a message confirmed from it needs confirming
 * again, because its text is no longer the text that stands.
 */
@Injectable()
export class MessageTemplatesService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly capabilities: CapabilityService,
    private readonly schedule: MessageScheduleService,
  ) {}

  /** The placeholder vocabulary, for the screens that write templates. */
  async placeholders(principal: Principal): Promise<MessagePlaceholderList> {
    await this.requireRead(principal);
    return {
      items: MESSAGE_PLACEHOLDER_NAMES.map((name) => ({
        name,
        label: MESSAGE_PLACEHOLDERS[name].label,
        subjects: [...MESSAGE_PLACEHOLDERS[name].subjects],
      })),
    };
  }

  async list(principal: Principal, query: ListMessageTemplatesQuery): Promise<MessageTemplateList> {
    const organizationId = await this.requireRead(principal);
    let q = this.uow
      .reader()
      .selectFrom('message_templates')
      .selectAll()
      .where('organization_id', '=', organizationId);
    if (query.status) q = q.where('status', '=', query.status);
    const rows = await q.orderBy('name').orderBy('id').execute();
    return { items: rows.map(toTemplate) };
  }

  async get(principal: Principal, id: string): Promise<MessageTemplate> {
    const organizationId = await this.requireRead(principal);
    const row = await this.uow
      .reader()
      .selectFrom('message_templates')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw errors.notFound('message_template', id);
    return toTemplate(row);
  }

  async create(
    principal: Principal,
    input: CreateMessageTemplateInput,
    correlationId: string | null,
  ): Promise<MessageTemplate> {
    const organizationId = organizationOf(principal);
    const id = newId();
    return this.uow.run(async ({ trx }) => {
      await this.authorization.require(principal, CommunicationsActions.manageMessageTemplates, {
        type: 'message_template',
        organizationId,
      });
      await this.capabilities.require(organizationId, 'message_sequences', trx);
      // A joined unit (a savepoint), so a refused name does not abort the request's transaction.
      await this.namedOnce(() =>
        this.uow.run(({ trx: inner }) =>
          inner
            .insertInto('message_templates')
            .values({
              id,
              organization_id: organizationId,
              name: input.name,
              category: input.category,
              title: input.title,
              body: input.body,
              created_by: json(snapshotActor(principal)),
            })
            .execute(),
        ),
      );
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: CommunicationsActions.manageMessageTemplates.id,
        targetType: 'message_template',
        targetId: id,
        afterRevision: 1,
        reason: input.reason ?? null,
        correlationId,
        details: { operation: 'create', category: input.category },
      });
      const row = await trx
        .selectFrom('message_templates')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
      return toTemplate(row);
    });
  }

  async update(
    principal: Principal,
    id: string,
    input: UpdateMessageTemplateInput,
    correlationId: string | null,
  ): Promise<MessageTemplate> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const current = await trx
        .selectFrom('message_templates')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      if (!current) throw errors.notFound('message_template', id);
      await this.authorization.require(principal, CommunicationsActions.manageMessageTemplates, {
        type: 'message_template',
        id,
        organizationId,
      });
      await this.capabilities.require(organizationId, 'message_sequences', trx);
      assertExpectedRevision(input.expectedRevision, current.revision);
      const next = {
        name: input.name ?? current.name,
        title: input.title ?? current.title,
        body: input.body ?? current.body,
        status: input.status ?? current.status,
      };
      await this.namedOnce(() =>
        this.uow.run(async ({ trx: inner }) => {
          const result = await inner
            .updateTable('message_templates')
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
        action: CommunicationsActions.manageMessageTemplates.id,
        targetType: 'message_template',
        targetId: id,
        beforeRevision: current.revision,
        afterRevision: current.revision + 1,
        reason: input.reason ?? null,
        correlationId,
        details: {
          operation: 'update',
          fields: Object.keys(input).filter((k) => k !== 'expectedRevision' && k !== 'reason'),
          status: next.status,
          previousStatus: current.status,
        },
      });
      const textChanged = next.title !== current.title || next.body !== current.body;
      if (textChanged) {
        // Messages confirmed from the old text need confirming again; sent ones keep their text.
        await this.schedule.followTemplate(trx, principal, organizationId, id, correlationId);
      }
      const row = await trx
        .selectFrom('message_templates')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
      return toTemplate(row);
    });
  }

  private async requireRead(principal: Principal): Promise<string> {
    const organizationId = organizationOf(principal);
    await this.authorization.require(principal, CommunicationsActions.readMessageSchedule, {
      type: 'message_template',
      organizationId,
    });
    return organizationId;
  }

  /** One active template per name: the database's answer becomes RESOURCE_CONFLICT. */
  private async namedOnce(write: () => Promise<unknown>): Promise<void> {
    try {
      await write();
    } catch (error) {
      const violation = databaseConstraintOf(error);
      if (violation?.code === '23505' && violation.constraint === NAME_INDEX) {
        throw errors.resourceConflict('An active template with this name already exists.', {
          code: 'TEMPLATE_NAME_TAKEN',
        });
      }
      throw error;
    }
  }
}
