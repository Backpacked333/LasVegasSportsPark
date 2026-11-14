import { Controller, Get, HttpCode, Patch, Post } from '@nestjs/common';
import {
  AddMessageSequenceStepBody,
  ConfirmScheduledMessageBody,
  CreateMessageSequenceBody,
  CreateMessageTemplateBody,
  EditScheduledMessageBody,
  GenerateMessageScheduleBody,
  ListMessageSequencesQuery,
  ListMessageTemplatesQuery,
  MessageScheduleParams,
  RemoveMessageSequenceStepBody,
  RestoreScheduledMessageBody,
  SkipScheduledMessageBody,
  UpdateMessageSequenceBody,
  UpdateMessageSequenceStepBody,
  UpdateMessageTemplateBody,
  z,
  type MessagePlaceholderList,
  type MessageSchedule,
  type MessageSequence,
  type MessageSequenceList,
  type MessageTemplate,
  type MessageTemplateList,
  type Principal,
  type ScheduledMessage,
  type ScheduledMessagePreview,
} from '@sportspark/contracts';
import {
  CurrentPrincipal,
  Idempotent,
  NoRecordAuthority,
  ZodBody,
  ZodParams,
  ZodQuery,
} from '../../../kernel';
import { MessageScheduleService } from '../sequences/message-schedule.service';
import { MessageSequencesService } from '../sequences/message-sequences.service';
import { MessageTemplatesService } from '../sequences/message-templates.service';
import { CorrelationId } from './correlation.decorator';

const IdParams = z.object({ id: z.uuid() });
const StepParams = z.object({ id: z.uuid(), stepId: z.uuid() });
type ScheduleParams = z.infer<typeof MessageScheduleParams>;

/** Templates, sequences and scheduled messages are no §5.3 record category of any system. */
const NOT_A_RECORD = 'Message templates, sequences and schedules are not a §5.3 record category';

/**
 * Message templates and sequences (SPK-COMMS-009, proposed amendment PA-05; capability
 * `message_sequences`, DEC-099 pending). Creating and changing templates and sequences,
 * producing a schedule, and editing, confirming and restoring a message need the capability;
 * every read, skipping a message and removing a step never do.
 */
@Controller()
export class MessageSequencesController {
  constructor(
    private readonly templates: MessageTemplatesService,
    private readonly sequences: MessageSequencesService,
    private readonly schedule: MessageScheduleService,
  ) {}

  // ---- templates ----
  @Get('message-placeholders')
  placeholders(@CurrentPrincipal() principal: Principal): Promise<MessagePlaceholderList> {
    return this.templates.placeholders(principal);
  }

  @Get('message-templates')
  listTemplates(
    @CurrentPrincipal() principal: Principal,
    @ZodQuery(ListMessageTemplatesQuery) query: ListMessageTemplatesQuery,
  ): Promise<MessageTemplateList> {
    return this.templates.list(principal, query);
  }

  @Post('message-templates')
  @Idempotent()
  @NoRecordAuthority(NOT_A_RECORD)
  createTemplate(
    @CurrentPrincipal() principal: Principal,
    @ZodBody(CreateMessageTemplateBody) body: z.infer<typeof CreateMessageTemplateBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<MessageTemplate> {
    return this.templates.create(principal, body, correlationId);
  }

  @Get('message-templates/:id')
  getTemplate(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
  ): Promise<MessageTemplate> {
    return this.templates.get(principal, params.id);
  }

  @Patch('message-templates/:id')
  @Idempotent()
  @NoRecordAuthority(NOT_A_RECORD)
  updateTemplate(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(UpdateMessageTemplateBody) body: z.infer<typeof UpdateMessageTemplateBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<MessageTemplate> {
    return this.templates.update(principal, params.id, body, correlationId);
  }

  // ---- sequences ----
  @Get('message-sequences')
  listSequences(
    @CurrentPrincipal() principal: Principal,
    @ZodQuery(ListMessageSequencesQuery) query: ListMessageSequencesQuery,
  ): Promise<MessageSequenceList> {
    return this.sequences.list(principal, query);
  }

  @Post('message-sequences')
  @Idempotent()
  @NoRecordAuthority(NOT_A_RECORD)
  createSequence(
    @CurrentPrincipal() principal: Principal,
    @ZodBody(CreateMessageSequenceBody) body: z.infer<typeof CreateMessageSequenceBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<MessageSequence> {
    return this.sequences.create(principal, body, correlationId);
  }

  @Get('message-sequences/:id')
  getSequence(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
  ): Promise<MessageSequence> {
    return this.sequences.get(principal, params.id);
  }

  @Patch('message-sequences/:id')
  @Idempotent()
  @NoRecordAuthority(NOT_A_RECORD)
  updateSequence(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(UpdateMessageSequenceBody) body: z.infer<typeof UpdateMessageSequenceBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<MessageSequence> {
    return this.sequences.update(principal, params.id, body, correlationId);
  }

  @Post('message-sequences/:id/steps')
  @Idempotent()
  @NoRecordAuthority(NOT_A_RECORD)
  addStep(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(AddMessageSequenceStepBody) body: z.infer<typeof AddMessageSequenceStepBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<MessageSequence> {
    return this.sequences.addStep(principal, params.id, body, correlationId);
  }

  @Patch('message-sequences/:id/steps/:stepId')
  @Idempotent()
  @NoRecordAuthority(NOT_A_RECORD)
  updateStep(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(StepParams) params: z.infer<typeof StepParams>,
    @ZodBody(UpdateMessageSequenceStepBody) body: z.infer<typeof UpdateMessageSequenceStepBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<MessageSequence> {
    return this.sequences.updateStep(principal, params.id, params.stepId, body, correlationId);
  }

  @Post('message-sequences/:id/steps/:stepId/remove')
  @HttpCode(200)
  @Idempotent()
  @NoRecordAuthority(NOT_A_RECORD)
  removeStep(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(StepParams) params: z.infer<typeof StepParams>,
    @ZodBody(RemoveMessageSequenceStepBody) body: z.infer<typeof RemoveMessageSequenceStepBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<MessageSequence> {
    return this.sequences.removeStep(principal, params.id, params.stepId, body, correlationId);
  }

  // ---- schedules ----
  @Get('message-schedules/:subjectType/:subjectId')
  getSchedule(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(MessageScheduleParams) params: ScheduleParams,
  ): Promise<MessageSchedule> {
    return this.schedule.schedule(principal, { type: params.subjectType, id: params.subjectId });
  }

  @Post('message-schedules/:subjectType/:subjectId/generate')
  @HttpCode(200)
  @Idempotent()
  @NoRecordAuthority(NOT_A_RECORD)
  generate(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(MessageScheduleParams) params: ScheduleParams,
    @ZodBody(GenerateMessageScheduleBody) body: z.infer<typeof GenerateMessageScheduleBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<MessageSchedule> {
    return this.schedule.generate(
      principal,
      { type: params.subjectType, id: params.subjectId },
      body,
      correlationId,
    );
  }

  @Get('scheduled-messages/:id')
  getMessage(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
  ): Promise<ScheduledMessage> {
    return this.schedule.get(principal, params.id);
  }

  @Get('scheduled-messages/:id/preview')
  preview(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
  ): Promise<ScheduledMessagePreview> {
    return this.schedule.preview(principal, params.id);
  }

  @Post('scheduled-messages/:id/edit')
  @HttpCode(200)
  @Idempotent()
  @NoRecordAuthority(NOT_A_RECORD)
  edit(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(EditScheduledMessageBody) body: z.infer<typeof EditScheduledMessageBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<ScheduledMessage> {
    return this.schedule.edit(principal, params.id, body, correlationId);
  }

  @Post('scheduled-messages/:id/confirm')
  @HttpCode(200)
  @Idempotent()
  @NoRecordAuthority(NOT_A_RECORD)
  confirm(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(ConfirmScheduledMessageBody) body: z.infer<typeof ConfirmScheduledMessageBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<ScheduledMessage> {
    return this.schedule.confirm(principal, params.id, body, correlationId);
  }

  @Post('scheduled-messages/:id/skip')
  @HttpCode(200)
  @Idempotent()
  @NoRecordAuthority(NOT_A_RECORD)
  skip(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(SkipScheduledMessageBody) body: z.infer<typeof SkipScheduledMessageBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<ScheduledMessage> {
    return this.schedule.skip(principal, params.id, body, correlationId);
  }

  @Post('scheduled-messages/:id/restore')
  @HttpCode(200)
  @Idempotent()
  @NoRecordAuthority(NOT_A_RECORD)
  restore(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(RestoreScheduledMessageBody) body: z.infer<typeof RestoreScheduledMessageBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<ScheduledMessage> {
    return this.schedule.restore(principal, params.id, body, correlationId);
  }
}
