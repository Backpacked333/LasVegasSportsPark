import { Controller, Get, HttpCode, Post, Req } from '@nestjs/common';
import {
  ResumeAfterRecoveryBody,
  type Principal,
  type RecoveryStatus,
  type ResumeAfterRecoveryInput,
} from '@sportspark/contracts';
import { CurrentPrincipal } from '../auth/principal.decorator';
import { Idempotent } from '../http/idempotency.interceptor';
import type { RequestWithContext } from '../http/request-context';
import { ZodBody } from '../http/zod-validation.pipe';
import { RecoveryMode } from './recovery-mode.service';

/** §5.8, SPK-AT-028: recovery status and the explicit hand-back to normal operation. */
@Controller('recovery')
export class RecoveryController {
  constructor(private readonly recovery: RecoveryMode) {}

  @Get()
  status(@CurrentPrincipal() principal: Principal): Promise<RecoveryStatus> {
    return this.recovery.status(principal);
  }

  @Post('resume')
  @HttpCode(200)
  @Idempotent()
  resume(
    @CurrentPrincipal() principal: Principal,
    @ZodBody(ResumeAfterRecoveryBody) body: ResumeAfterRecoveryInput,
    @Req() request: RequestWithContext,
  ): Promise<RecoveryStatus> {
    return this.recovery.resume(principal, body, request.correlationId ?? null);
  }
}
