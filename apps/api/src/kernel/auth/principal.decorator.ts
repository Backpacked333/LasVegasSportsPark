import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { ANONYMOUS_PRINCIPAL, type Principal } from '@sportspark/contracts';
import type { RequestWithContext } from '../http/request-context';

/** Injects the authenticated principal into a controller handler parameter. */
export const CurrentPrincipal = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): Principal => {
    const request = ctx.switchToHttp().getRequest<RequestWithContext>();
    return request.principal ?? ANONYMOUS_PRINCIPAL;
  },
);
