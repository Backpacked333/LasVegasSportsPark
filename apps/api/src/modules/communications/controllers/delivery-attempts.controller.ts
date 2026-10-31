import { Controller, Post } from '@nestjs/common';
import { RetryDeliveryBody, z, type DeliveryAttempt, type Principal } from '@sportspark/contracts';
import {
  CurrentPrincipal,
  Idempotent,
  NoRecordAuthority,
  ZodBody,
  ZodParams,
} from '../../../kernel';
import { DeliveryRetryService } from '../services/delivery-retry.service';
import { CorrelationId } from './correlation.decorator';

const IdParams = z.object({ id: z.uuid() });

/** Staff recovery of a single failed delivery (COM-02, SPK-COMMS-004, SCR-S-40). */
@Controller('delivery-attempts')
export class DeliveryAttemptsController {
  constructor(private readonly retries: DeliveryRetryService) {}

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
}
