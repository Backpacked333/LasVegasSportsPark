import { systemPrincipal } from '@sportspark/contracts';
import type { OperationalExceptions, Trx } from '../../../kernel';

/** The system actor that settles the module's own coverage and qualification exceptions. */
export const COVERAGE_ACTOR = 'workforce.coverage';

/**
 * Settles one of the module's own operational exceptions (`workforce.uncovered_assignment`,
 * `workforce.unqualified_assignment`) as the system actor {@link COVERAGE_ACTOR}, if it is still
 * open or acknowledged once its row is locked; returns whether this call settled it.
 *
 * R4-OPS-MODULES-08 rework (SPK-UX-006, §4.9): an operator settles the same card on Today
 * (support's `POST /v1/exceptions/:id/close|resolve`) without any workforce lock, so it can commit
 * after the caller found the exception open, or be committing while the caller reaches it. The
 * kernel refuses to resolve or close an exception that is already settled (INVALID_TRANSITION),
 * and that refusal must never fail, or roll back, the workforce command that found the card moot
 * (a requirement edit, an acceptance, a cancellation follow-up). The locking read below waits for a
 * concurrent settlement and, under READ COMMITTED, re-checks the status on the row it committed, so
 * a card someone else settled first is skipped; once the row is locked here nobody else can settle
 * it before this transaction ends.
 */
export async function settleIfStillOpen(
  exceptions: OperationalExceptions,
  trx: Trx,
  organizationId: string,
  exceptionId: string,
  to: 'resolved' | 'closed',
  options: {
    reason: string;
    resolution?: Record<string, unknown>;
    correlationId: string | null;
  },
): Promise<boolean> {
  const still = await trx
    .selectFrom('operational_exceptions')
    .select('id')
    .where('organization_id', '=', organizationId)
    .where('id', '=', exceptionId)
    .where('status', 'in', ['open', 'acknowledged'])
    .forUpdate()
    .executeTakeFirst();
  if (!still) return false;
  await exceptions.transition(
    trx,
    systemPrincipal(organizationId, COVERAGE_ACTOR),
    exceptionId,
    to,
    {
      reason: options.reason,
      resolution: options.resolution,
      correlationId: options.correlationId ?? undefined,
    },
  );
  return true;
}
