import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Principal } from '@sportspark/contracts';
import type { Request } from 'express';

export interface RequestWithContext extends Request {
  correlationId: string;
  principal?: Principal;
}

/** Injects the request's correlation id (`X-Correlation-Id`, §4.10) into a handler parameter. */
export const CurrentCorrelationId = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string | null =>
    ctx.switchToHttp().getRequest<RequestWithContext>().correlationId ?? null,
);
