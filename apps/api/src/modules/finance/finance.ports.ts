/**
 * Payment provider port (specification §5.2: the processor is not selected, DEC-019). Code runs
 * against this interface with the deterministic `FakePaymentProvider`; a real adapter implements
 * the same contract once the processor and merchant account are decided. Every call happens
 * OUTSIDE a database transaction (§4.11) and carries an idempotency key, so a repeated call never
 * charges twice. A thrown error means the outcome is unknown (SPK-PAY-007), never "failed".
 */
export const PAYMENT_PROVIDER_PORT = Symbol('PAYMENT_PROVIDER_PORT');

export type ProviderPaymentStatus =
  'succeeded' | 'requires_action' | 'processing' | 'failed' | 'canceled';

export interface ProviderPaymentResult {
  providerReference: string;
  status: ProviderPaymentStatus;
  amountMinor: number;
  currency: string;
  /** Processor fee the provider reports for a captured payment (SPK-PAY-011 "processor fees"). */
  feeMinor: number | null;
  /** What the customer must do next (a challenge); never card data. */
  actionPayload: Record<string, unknown> | null;
  failureReason: string | null;
}

export interface CreatePaymentRequest {
  /** The payment attempt id: the provider deduplicates on it. */
  idempotencyKey: string;
  amountMinor: number;
  currency: string;
  /** Opaque token from the provider's hosted fields (card details never touch this API). */
  paymentMethodRef: string;
  metadata: { organizationId: string; paymentAttemptId: string };
}

export type ProviderRefundStatus = 'succeeded' | 'processing' | 'failed';

export interface ProviderRefundResult {
  providerReference: string;
  status: ProviderRefundStatus;
  amountMinor: number;
  currency: string;
  failureReason: string | null;
}

export interface CreateRefundRequest {
  /** The refund attempt id: the provider deduplicates on it. */
  idempotencyKey: string;
  providerPaymentReference: string;
  amountMinor: number;
  currency: string;
  metadata: { organizationId: string; refundAttemptId: string };
}

export interface PaymentProviderPort {
  readonly name: string;
  /** Throws when the outcome is not known (timeout, transport failure): the caller records `unknown`. */
  createPayment(request: CreatePaymentRequest): Promise<ProviderPaymentResult>;
  /** Authoritative lookup by idempotency key for reconciliation; null when the provider has no record. */
  retrievePayment(idempotencyKey: string): Promise<ProviderPaymentResult | null>;
  /**
   * Cancels a payment that still waits for the customer (an abandoned challenge, SPK-PAY-007).
   * Returns `canceled`, or the state the payment already reached when it can no longer be canceled
   * (succeeded, failed, processing); null when the provider has no record. Idempotent per key.
   * Throws when no answer arrives (unknown outcome). The challenge validity window and the exact
   * cancel semantics depend on the processor (DEC-019 pending).
   */
  cancelPayment(idempotencyKey: string): Promise<ProviderPaymentResult | null>;
  /**
   * An adapter must bound this call well below `reconcileAfterMinutes`: reconciliation treats a
   * refund the provider still has no record of after that threshold as never received.
   */
  createRefund(request: CreateRefundRequest): Promise<ProviderRefundResult>;
  retrieveRefund(idempotencyKey: string): Promise<ProviderRefundResult | null>;
  /** Authenticates a webhook body (§4.11 "Webhook handlers must authenticate provider events"). */
  verifyWebhook(body: unknown, signature: string | undefined): boolean;
}

/** The provider did not answer with an outcome (timeout or transport failure). */
export class PaymentOutcomeUnknownError extends Error {
  override readonly name = 'PaymentOutcomeUnknownError';
}
