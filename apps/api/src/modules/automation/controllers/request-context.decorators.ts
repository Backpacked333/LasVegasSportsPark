import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { RequestWithContext } from '../../../kernel';

/** Injects the request correlation id so audit records, operations and events carry it (§4.10). */
export const CorrelationId = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string => {
    const request = ctx.switchToHttp().getRequest<RequestWithContext>();
    return request.correlationId;
  },
);
