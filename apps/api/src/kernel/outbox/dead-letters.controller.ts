import { Controller, HttpCode, Post } from '@nestjs/common';
import {
  DeadLetterParams,
  ReplayDeadLetterBody,
  z,
  type DeadLetterReplayView,
  type Principal,
  type ReplayDeadLetterInput,
} from '@sportspark/contracts';
import { CurrentPrincipal } from '../auth/principal.decorator';
import { Idempotent } from '../http/idempotency.interceptor';
import { NoRecordAuthority } from '../http/record-authority.decorator';
import { CurrentCorrelationId } from '../http/request-context';
import { ZodBody, ZodParams } from '../http/zod-validation.pipe';
import { DeadLetters } from './dead-letters';

/**
 * Replay of dead-lettered outbox and provider events (R3-OPERATIONS-03, §5.11 supported resolution
 * actions, §4.12): the owner of the failure queue (or the general manager or system
 * administration) re-runs the follow-up once its cause is fixed; audited.
 */
@Controller()
export class DeadLettersController {
  constructor(private readonly deadLetters: DeadLetters) {}

  @Post('outbox-events/:id/replay')
  @HttpCode(200)
  @Idempotent()
  @NoRecordAuthority('Not a §5.3 record category: a kernel delivery record')
  replayOutboxEvent(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(DeadLetterParams) params: z.infer<typeof DeadLetterParams>,
    @ZodBody(ReplayDeadLetterBody) body: ReplayDeadLetterInput,
    @CurrentCorrelationId() correlationId: string | null,
  ): Promise<DeadLetterReplayView> {
    return this.deadLetters.replayOutboxEvent(principal, params.id, body, correlationId);
  }

  @Post('provider-events/:id/replay')
  @HttpCode(200)
  @Idempotent()
  @NoRecordAuthority('Not a §5.3 record category: a kernel delivery record')
  replayProviderEvent(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(DeadLetterParams) params: z.infer<typeof DeadLetterParams>,
    @ZodBody(ReplayDeadLetterBody) body: ReplayDeadLetterInput,
    @CurrentCorrelationId() correlationId: string | null,
  ): Promise<DeadLetterReplayView> {
    return this.deadLetters.replayInboxEvent(principal, params.id, body, correlationId);
  }
}
