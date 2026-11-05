import { Controller, HttpCode, Post } from '@nestjs/common';
import {
  ReconcileDeliveryBody,
  RetryDeliveryBody,
  z,
  type DeliveryAttempt,
  type Principal,
} from '@sportspark/contracts';
import {
  CurrentPrincipal,
  Idempotent,
  NoRecordAuthority,
  ZodBody,
  ZodParams,
} from '../../../kernel';
import { DeliveryReconciliationService } from '../services/delivery-reconciliation.service';
import { DeliveryRetryService } from '../services/delivery-retry.service';
import { CorrelationId } from './correlation.decorator';

const IdParams = z.object({ id: z.uuid() });

/**
 * Staff recovery of a single delivery (SPK-COMMS-004, SCR-S-40): retry a failed one (COM-02), or
 * record the outcome established for one whose hand-off ended unknown (§4.11, §5.11).
 */
@Controller('delivery-attempts')
export class DeliveryAttemptsController {
  constructor(
    private readonly retries: DeliveryRetryService,
    private readonly reconciliations: DeliveryReconciliationService,
  ) {}

  @Post(':id/retry')
  @Idempotent()
  @NoRecordAuthority('Not a §5.3 record category')
  retry(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(RetryDeliveryBody) body: z.infer<typeof RetryDeliveryBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<DeliveryAttempt> {
    return this.retries.retry(principal, params.id, body, correlationId);
  }

  @Post(':id/reconcile')
  @HttpCode(200)
  @Idempotent()
  @NoRecordAuthority('Not a §5.3 record category')
  reconcile(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(ReconcileDeliveryBody) body: z.infer<typeof ReconcileDeliveryBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<DeliveryAttempt> {
    return this.reconciliations.reconcile(principal, params.id, body, correlationId);
  }
}
