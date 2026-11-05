import { Injectable } from '@nestjs/common';
import type { Trx } from '../../../kernel';

/** What the guarded command does to the closure. */
export type ClosureGuardedOperation = 'lift' | 'withdraw';

/**
 * A check another module runs before a scheduling closure is lifted, or withdrawn over HTTP. It
 * throws a domain error to refuse the change and returns to allow it; it reads through `trx`, the
 * command's own transaction.
 */
export type ClosureLiftGuard = (
  trx: Trx,
  organizationId: string,
  closureId: string,
  operation: ClosureGuardedOperation,
) => Promise<void>;

/**
 * Closure lift guards (SPK-FAC-004 "returning a space to service requires an authorized release",
 * SPK-AT-021). A module that backs closures with its own authority (facilities restrictions)
 * registers a guard in `onModuleInit`; `ClosuresService.liftClosure` runs every guard inside its
 * transaction, after authorization and the lifecycle check and before the lift is written, so a
 * lift outside that module's release is refused instead of being surfaced after the space has
 * already become bookable. Scheduling reads no other module's tables (§4.2).
 */
@Injectable()
export class ClosureLiftGuards {
  private readonly guards = new Map<string, ClosureLiftGuard>();

  register(name: string, guard: ClosureLiftGuard): void {
    if (this.guards.has(name)) throw new Error(`closure lift guard ${name} already registered`);
    this.guards.set(name, guard);
  }

  async check(
    trx: Trx,
    organizationId: string,
    closureId: string,
    operation: ClosureGuardedOperation = 'lift',
  ): Promise<void> {
    for (const guard of this.guards.values()) {
      await guard(trx, organizationId, closureId, operation);
    }
  }
}
