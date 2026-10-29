import type { RecoveryBlocker } from '@sportspark/contracts';
import type { Db } from '@sportspark/db';
import type { Trx } from '../../../kernel';

/**
 * Finance's answer to the kernel recovery gate (§5.8 "reconcile external facts", SPK-AT-028,
 * SPK-PAY-007, SPK-PAY-010). After a restore the database may not know what the provider did
 * since the backup, so normal operation resumes only when:
 *
 * 1. no payment attempt is still `created`, `action_required`, `processing` or `unknown`: each is
 *    resolved from provider evidence (the worker's reconciliation by idempotency key, a webhook, or
 *    `POST /v1/payments/{id}/reconcile`);
 * 2. no refund attempt is still `requested`, `processing` or `unknown` (likewise);
 * 3. a processor settlement reconciliation performed since recovery began is balanced: the
 *    provider's reported totals equal the local receipts, so no charge or refund made after the
 *    backup is missing locally (§5.5 "Finance accepts the balances").
 *
 * A provider feed that recreates the missing per-payment facts is pending (DEC-019); until it
 * exists a discrepancy keeps recovery open for Finance to resolve.
 */
export async function financeRecoveryBlockers(
  db: Db | Trx,
  organizationId: string,
  since: Date,
): Promise<RecoveryBlocker[]> {
  const blockers: RecoveryBlocker[] = [];
  const payments = await db
    .selectFrom('payment_attempts')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('organization_id', '=', organizationId)
    .where('status', 'in', ['created', 'action_required', 'processing', 'unknown'])
    .executeTakeFirstOrThrow();
  if (Number(payments.n) > 0) {
    blockers.push({
      check: 'finance.provider_facts',
      code: 'payment_outcomes_unresolved',
      message: 'Payment attempts whose provider outcome is not recorded yet must be reconciled.',
      count: Number(payments.n),
    });
  }
  const refunds = await db
    .selectFrom('refund_attempts')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('organization_id', '=', organizationId)
    .where('status', 'in', ['requested', 'processing', 'unknown'])
    .executeTakeFirstOrThrow();
  if (Number(refunds.n) > 0) {
    blockers.push({
      check: 'finance.provider_facts',
      code: 'refund_outcomes_unresolved',
      message: 'Refunds whose provider outcome is not recorded yet must be reconciled.',
      count: Number(refunds.n),
    });
  }
  const settlement = await db
    .selectFrom('settlement_reconciliations')
    .select(['status'])
    .where('organization_id', '=', organizationId)
    .where('kind', '=', 'processor_settlement')
    .where('performed_at', '>=', since)
    .orderBy('performed_at', 'desc')
    .orderBy('created_at', 'desc')
    .executeTakeFirst();
  if (!settlement || settlement.status !== 'balanced') {
    blockers.push({
      check: 'finance.provider_facts',
      code: settlement ? 'processor_settlement_discrepancy' : 'processor_settlement_missing',
      message: settlement
        ? 'The latest processor settlement reconciliation since the restore shows a discrepancy.'
        : 'Record a processor settlement reconciliation since the restore (POST /v1/settlement-reconciliations).',
    });
  }
  return blockers;
}
