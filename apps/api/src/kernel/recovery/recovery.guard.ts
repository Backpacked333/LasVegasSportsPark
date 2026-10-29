import { Injectable, SetMetadata, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DomainError } from '@sportspark/contracts';
import type { RequestWithContext } from '../http/request-context';
import { RecoveryMode } from './recovery-mode.service';

export const RECOVERY_SCOPE_KEY = 'sportspark:recovery-scope';

/**
 * Marks commands that must not run on restored state until provider facts are reconciled
 * (§5.8, SPK-AT-028): commands that move money or create financial obligations. Applies to the
 * controller's non-read methods; reads stay available.
 */
export const RefusedDuringRecovery = () => SetMetadata(RECOVERY_SCOPE_KEY, 'refused');

/** Exempts one handler of a refused controller: reconciliation commands and provider evidence. */
export const AllowedDuringRecovery = () => SetMetadata(RECOVERY_SCOPE_KEY, 'allowed');

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Global guard (after authentication): while the caller's organization is recovering from a
 * restore, a `@RefusedDuringRecovery()` command answers 503 INTEGRATION_UNAVAILABLE with next action
 * `retry_later` and `details.reason = recovery_mode` (the acceptance fixture's mapping; §4.10 has no
 * dedicated recovery category). It runs before the idempotency interceptor, so a refused request
 * claims no idempotency key and may be retried with the same key after recovery.
 */
@Injectable()
export class RecoveryGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly recovery: RecoveryMode,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const request = context.switchToHttp().getRequest<RequestWithContext>();
    if (READ_METHODS.has(request.method.toUpperCase())) return true;
    const scope = this.reflector.getAllAndOverride<'refused' | 'allowed' | undefined>(
      RECOVERY_SCOPE_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (scope !== 'refused') return true;
    const organizationId = request.principal?.organizationId;
    if (!organizationId) return true;
    if (await this.recovery.isActive(organizationId)) {
      throw new DomainError(
        'INTEGRATION_UNAVAILABLE',
        'Payments are paused while the service recovers from a restore. Try again later.',
        { details: { reason: 'recovery_mode' } },
      );
    }
    return true;
  }
}
