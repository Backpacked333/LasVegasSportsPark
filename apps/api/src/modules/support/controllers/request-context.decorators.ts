import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { IDEMPOTENCY_KEY_HEADER } from '@sportspark/contracts';
import type { RequestWithContext } from '../../../kernel';

/** Injects the request correlation id so audit records and events can carry it (§4.10). */
export const CorrelationId = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string => {
    const request = ctx.switchToHttp().getRequest<RequestWithContext>();
    return request.correlationId;
  },
);

/**
 * The validated `Idempotency-Key` of an `@Idempotent()` command. Helper commands store it on the
 * case action so a retry after an unknown outcome is refused instead of executed twice (§4.9).
 */
export const IdempotencyKeyHeader = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string => {
    const request = ctx.switchToHttp().getRequest<RequestWithContext>();
    const raw = request.headers[IDEMPOTENCY_KEY_HEADER];
    return (Array.isArray(raw) ? raw[0] : raw) ?? '';
  },
);
