import type {
  AccountingExportPort,
  CreatePaymentRequest,
  CreateRefundRequest,
  PaymentProviderPort,
  ProviderPaymentResult,
  ProviderRefundResult,
} from '../finance.ports';

/** The adapter name a gate reports while no provider is selected (`<SELECTOR>=none`). */
export const UNSELECTED_PROVIDER = 'none';

/**
 * The payment port while no processor is selected (`PAYMENT_PROVIDER=none`, §5.2, DEC-019): no
 * money moves. A payment attempt is answered `failed` with a reason staff and customers can read,
 * so the attempt is recorded and nothing waits on an outcome that cannot come; lookups find no
 * record and webhooks never authenticate. Refunds cannot arise (no payment ever succeeds), and one
 * asked for anyway fails the same way.
 */
export const unselectedPaymentProvider: PaymentProviderPort = {
  name: UNSELECTED_PROVIDER,
  createPayment: async (request: CreatePaymentRequest): Promise<ProviderPaymentResult> => ({
    providerReference: `none_${request.idempotencyKey}`,
    status: 'failed',
    amountMinor: request.amountMinor,
    currency: request.currency,
    feeMinor: null,
    actionPayload: null,
    failureReason: 'no_payment_provider_selected',
  }),
  retrievePayment: async () => null,
  cancelPayment: async () => null,
  createRefund: async (request: CreateRefundRequest): Promise<ProviderRefundResult> => ({
    providerReference: `none_${request.idempotencyKey}`,
    status: 'failed',
    amountMinor: request.amountMinor,
    currency: request.currency,
    failureReason: 'no_payment_provider_selected',
  }),
  retrieveRefund: async () => null,
  verifyWebhook: () => false,
};

/**
 * The accounting port while no connection is selected (`ACCOUNTING_PROVIDER=none`, §5.2,
 * DEC-022): a submitted batch is rejected with a readable reason and a status lookup finds
 * nothing, so batches stay with the finance operator instead of waiting on a connection.
 */
export const unselectedAccountingProvider: AccountingExportPort = {
  name: UNSELECTED_PROVIDER,
  submitBatch: async () => ({ outcome: 'rejected', error: 'no_accounting_connection_selected' }),
  batchStatus: async () => ({ outcome: 'not_found' }),
};
