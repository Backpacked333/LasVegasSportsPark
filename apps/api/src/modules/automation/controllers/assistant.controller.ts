import { Controller, Get, Post, UseGuards } from '@nestjs/common';
import {
  CreateAssistantRequestBody,
  z,
  type AssistantRequest,
  type CreateAssistantRequestInput,
  type Principal,
} from '@sportspark/contracts';
import { CurrentPrincipal, Idempotent, ZodBody, ZodParams } from '../../../kernel';
import { AssistantService } from '../services/assistant.service';
import { AutomationEnabledGuard } from './automation-enabled.guard';
import { CorrelationId } from './request-context.decorators';

const IdParams = z.object({ id: z.uuid() });
type IdParams = z.infer<typeof IdParams>;

/** Assistant requests (SPK-AUTO-001, SPK-AUTO-002, SPK-AUTO-004); requester only. */
@Controller('assistant/requests')
@UseGuards(AutomationEnabledGuard)
export class AssistantController {
  constructor(private readonly assistant: AssistantService) {}

  @Post()
  @Idempotent()
  ask(
    @CurrentPrincipal() principal: Principal,
    @ZodBody(CreateAssistantRequestBody) body: CreateAssistantRequestInput,
    @CorrelationId() correlationId: string,
  ): Promise<AssistantRequest> {
    return this.assistant.ask(principal, body, correlationId);
  }

  @Get(':id')
  get(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: IdParams,
  ): Promise<AssistantRequest> {
    return this.assistant.get(principal, params.id);
  }
}
