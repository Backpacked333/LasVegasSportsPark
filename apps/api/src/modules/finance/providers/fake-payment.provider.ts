import { createHmac, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { PaymentWebhookInput } from '@sportspark/contracts';
import {
  PaymentOutcomeUnknownError,
  type CreatePaymentRequest,
  type CreateRefundRequest,
  type PaymentProviderPort,
  type ProviderPaymentResult,
  type ProviderPaymentStatus,
  type ProviderRefundResult,
  type ProviderRefundStatus,
} from '../finance.ports';

export const FAKE_PAYMENTS_PROVIDER = 'fake-payments';
/** Test-only shared secret for webhook signatures; a real provider's secret arrives via the environment. */
export const FAKE_PAYMENTS_WEBHOOK_SECRET = 'fake-payments-webhook-secret';
export const FAKE_PAYMENTS_SIGNATURE_HEADER = 'x-payments-signature';

/**
 * Deterministic payment-method tokens (what the provider's hosted fields would return). Card
 * details never exist in this system; a token selects the scenario:
 */
export const FakePaymentTokens = {
  /** Captured at once. */
  succeed: 'pm_fake_visa',
  /** The customer must complete a challenge; the outcome arrives by webhook. */
  requireAction: 'pm_fake_action',
  /** Declined by the issuer. */
  decline: 'pm_fake_decline',
  /** Accepted for asynchronous processing; the outcome arrives by webhook. */
  processing: 'pm_fake_processing',
  /** The call times out AFTER the provider captured the money (outcome unknown to us). */
  timeout: 'pm_fake_timeout',
  /** The call times out and the provider declined (outcome unknown to us). */
  timeoutDeclined: 'pm_fake_timeout_decline',
  /** The request never reaches the provider (outcome unknown to us; lookup finds nothing). */
  unreachable: 'pm_fake_unreachable',
} as const;

export type FakeRefundOutcome = 'succeed' | 'fail' | 'processing' | 'timeout';
/**
 * Scripted behaviour of the next cancel calls: `timeout` answers nothing (the payment is left as
 * it was); `succeed` means the customer completed the challenge just before the cancel arrived.
 */
export type FakeCancelOutcome = 'timeout' | 'succeed';

interface FakeCharge {
  reference: string;
  idempotencyKey: string;
  amountMinor: number;
  currency: string;
  status: ProviderPaymentStatus;
  feeMinor: number | null;
  failureReason: string | null;
  actionPayload: Record<string, unknown> | null;
  metadata: { organizationId: string; paymentAttemptId: string };
  sequence: number;
}

interface FakeRefund {
  reference: string;
  idempotencyKey: string;
  paymentReference: string;
  amountMinor: number;
  currency: string;
  status: ProviderRefundStatus;
  failureReason: string | null;
  metadata: { organizationId: string; refundAttemptId: string };
  sequence: number;
}

/** 2.9% + 30 minor units, rounded half up: a deterministic stand-in for processor pricing. */
export function fakeFeeFor(amountMinor: number): number {
  return Math.floor((2 * amountMinor * 290 + 10_000) / 20_000) + 30;
}

/**
 * Deterministic fake payment processor (specification §5.2: no processor is selected, DEC-019).
 * Supports success, required action, decline, asynchronous processing, timeout with an unknown
 * outcome, unreachable provider, refunds (scriptable), and signed webhooks including duplicates
 * and out-of-order deliveries. A repeated call with the same idempotency key returns the original
 * outcome and never charges again (the property a real processor must also provide).
 */
@Injectable()
export class FakePaymentProvider implements PaymentProviderPort {
  readonly name = FAKE_PAYMENTS_PROVIDER;
  private readonly charges = new Map<string, FakeCharge>();
  private readonly refunds = new Map<string, FakeRefund>();
  private readonly refundScript: FakeRefundOutcome[] = [];
  private readonly paymentScript: string[] = [];
  private readonly cancelScript: FakeCancelOutcome[] = [];
  /** Every createPayment call, including deduplicated repeats (tests assert on it). */
  readonly paymentCalls: CreatePaymentRequest[] = [];
  readonly refundCalls: CreateRefundRequest[] = [];
  /** Every cancelPayment call (idempotency keys), including repeats. */
  readonly cancelCalls: string[] = [];
  private eventCounter = 0;

  reset(): void {
    this.charges.clear();
    this.refunds.clear();
    this.refundScript.length = 0;
    this.paymentScript.length = 0;
    this.cancelScript.length = 0;
    this.paymentCalls.length = 0;
    this.refundCalls.length = 0;
    this.cancelCalls.length = 0;
  }

  /**
   * The next NEW payment calls, in order, behave as if made with these tokens regardless of the
   * stored payment method (for example a saved card that is declined at installment collection).
   */
  scriptPayments(
    ...tokens: Array<(typeof FakePaymentTokens)[keyof typeof FakePaymentTokens]>
  ): void {
    this.paymentScript.push(...tokens);
  }

  /** The next refund calls, in order, produce these outcomes (default `succeed`). */
  scriptRefunds(...outcomes: FakeRefundOutcome[]): void {
    this.refundScript.push(...outcomes);
  }

  /** The next cancel calls, in order, behave like this (default: cancel what can be canceled). */
  scriptCancels(...outcomes: FakeCancelOutcome[]): void {
    this.cancelScript.push(...outcomes);
  }

  /** Distinct charges the provider holds (a deduplicated repeat is not a second charge). */
  chargeCount(status?: ProviderPaymentStatus): number {
    return [...this.charges.values()].filter((c) => !status || c.status === status).length;
  }

  static referenceFor(idempotencyKey: string): string {
    return `fp_${idempotencyKey}`;
  }

  async createPayment(request: CreatePaymentRequest): Promise<ProviderPaymentResult> {
    this.paymentCalls.push(request);
    const existing = this.charges.get(request.idempotencyKey);
    if (existing) return this.paymentResult(existing);
    const token = this.paymentScript.shift() ?? request.paymentMethodRef;
    if (token === FakePaymentTokens.unreachable) {
      throw new PaymentOutcomeUnknownError('fake provider unreachable (scenario)');
    }
    const charge: FakeCharge = {
      reference: FakePaymentProvider.referenceFor(request.idempotencyKey),
      idempotencyKey: request.idempotencyKey,
      amountMinor: request.amountMinor,
      currency: request.currency,
      status: 'succeeded',
      feeMinor: null,
      failureReason: null,
      actionPayload: null,
      metadata: request.metadata,
      sequence: 1,
    };
    switch (token) {
      case FakePaymentTokens.decline:
      case FakePaymentTokens.timeoutDeclined:
        charge.status = 'failed';
        charge.failureReason = 'card_declined';
        break;
      case FakePaymentTokens.requireAction:
        charge.status = 'requires_action';
        charge.actionPayload = {
          type: 'challenge',
          url: `https://fake-payments.invalid/challenge/${charge.reference}`,
        };
        break;
      case FakePaymentTokens.processing:
        charge.status = 'processing';
        break;
      default:
        charge.status = 'succeeded';
        charge.feeMinor = fakeFeeFor(request.amountMinor);
    }
    this.charges.set(request.idempotencyKey, charge);
    if (token === FakePaymentTokens.timeout || token === FakePaymentTokens.timeoutDeclined) {
      throw new PaymentOutcomeUnknownError('fake provider timed out (scenario)');
    }
    return this.paymentResult(charge);
  }

  async retrievePayment(idempotencyKey: string): Promise<ProviderPaymentResult | null> {
    const charge = this.charges.get(idempotencyKey);
    return charge ? this.paymentResult(charge) : null;
  }

  /**
   * Cancels a payment still waiting for the customer's challenge; any other state is returned as
   * it is (it can no longer be canceled). Null when no charge exists for the key.
   */
  async cancelPayment(idempotencyKey: string): Promise<ProviderPaymentResult | null> {
    this.cancelCalls.push(idempotencyKey);
    const outcome = this.cancelScript.shift();
    if (outcome === 'timeout') {
      throw new PaymentOutcomeUnknownError('fake provider cancel timed out (scenario)');
    }
    const charge = this.charges.get(idempotencyKey);
    if (!charge) return null;
    if (outcome === 'succeed' && charge.status === 'requires_action') {
      this.settlePayment(idempotencyKey, 'succeeded');
    } else if (charge.status === 'requires_action') {
      charge.status = 'canceled';
      charge.sequence += 1;
      charge.actionPayload = null;
      charge.failureReason = 'action_abandoned';
    }
    return this.paymentResult(charge);
  }

  async createRefund(request: CreateRefundRequest): Promise<ProviderRefundResult> {
    this.refundCalls.push(request);
    const existing = this.refunds.get(request.idempotencyKey);
    if (existing) return this.refundResult(existing);
    const outcome = this.refundScript.shift() ?? 'succeed';
    const refund: FakeRefund = {
      reference: `fr_${request.idempotencyKey}`,
      idempotencyKey: request.idempotencyKey,
      paymentReference: request.providerPaymentReference,
      amountMinor: request.amountMinor,
      currency: request.currency,
      status: outcome === 'fail' ? 'failed' : outcome === 'processing' ? 'processing' : 'succeeded',
      failureReason: outcome === 'fail' ? 'refund_rejected' : null,
      metadata: request.metadata,
      sequence: 1,
    };
    this.refunds.set(request.idempotencyKey, refund);
    if (outcome === 'timeout') {
      throw new PaymentOutcomeUnknownError('fake provider refund timed out (scenario)');
    }
    return this.refundResult(refund);
  }

  async retrieveRefund(idempotencyKey: string): Promise<ProviderRefundResult | null> {
    const refund = this.refunds.get(idempotencyKey);
    return refund ? this.refundResult(refund) : null;
  }

  verifyWebhook(body: unknown, signature: string | undefined): boolean {
    return FakePaymentProvider.verify(body, signature);
  }

  // -------------------------------------------------------------------------------------------
  // Scenario drivers: what the provider does later, and the signed webhook it would post
  // -------------------------------------------------------------------------------------------

  /** The customer completed (or failed) the challenge / asynchronous processing finished. */
  settlePayment(paymentAttemptId: string, outcome: 'succeeded' | 'failed'): void {
    const charge = this.charges.get(paymentAttemptId);
    if (!charge) throw new Error(`no fake charge for ${paymentAttemptId}`);
    charge.status = outcome;
    charge.sequence += 1;
    if (outcome === 'succeeded') charge.feeMinor = fakeFeeFor(charge.amountMinor);
    else charge.failureReason = 'card_declined';
    charge.actionPayload = null;
  }

  settleRefund(refundAttemptId: string, outcome: 'succeeded' | 'failed'): void {
    const refund = this.refunds.get(refundAttemptId);
    if (!refund) throw new Error(`no fake refund for ${refundAttemptId}`);
    refund.status = outcome;
    refund.sequence += 1;
    refund.failureReason = outcome === 'failed' ? 'refund_rejected' : null;
  }

  /**
   * The signed webhook the provider would post about a payment. `type` defaults to the charge's
   * current state; `sequence` defaults to its current sequence (pass a lower one to simulate an
   * older event delivered late). Event ids are deterministic unless given.
   */
  paymentWebhook(
    paymentAttemptId: string,
    options: {
      type?: PaymentWebhookInput['type'];
      sequence?: number;
      eventId?: string;
    } = {},
  ): { body: PaymentWebhookInput; signature: string } {
    const charge = this.charges.get(paymentAttemptId);
    if (!charge) throw new Error(`no fake charge for ${paymentAttemptId}`);
    const type = options.type ?? paymentEventType(charge.status);
    this.eventCounter += 1;
    const body: PaymentWebhookInput = {
      id: options.eventId ?? `evt_${charge.reference}_${type}_${this.eventCounter}`,
      type,
      sequence: options.sequence ?? charge.sequence,
      data: {
        organizationId: charge.metadata.organizationId,
        providerReference: charge.reference,
        paymentAttemptId: charge.metadata.paymentAttemptId,
        amountMinor: charge.amountMinor,
        currency: charge.currency,
        ...(type === 'payment.succeeded'
          ? { feeMinor: charge.feeMinor ?? fakeFeeFor(charge.amountMinor) }
          : {}),
        ...(type === 'payment.failed'
          ? { failureReason: charge.failureReason ?? 'card_declined' }
          : {}),
      },
    };
    return { body, signature: FakePaymentProvider.sign(body) };
  }

  refundWebhook(
    refundAttemptId: string,
    options: {
      type?: 'refund.succeeded' | 'refund.failed';
      sequence?: number;
      eventId?: string;
      /** A contradicting report (MONEY-09): the provider names another amount or currency. */
      amountMinor?: number;
      currency?: string;
    } = {},
  ): { body: PaymentWebhookInput; signature: string } {
    const refund = this.refunds.get(refundAttemptId);
    if (!refund) throw new Error(`no fake refund for ${refundAttemptId}`);
    const type =
      options.type ?? (refund.status === 'failed' ? 'refund.failed' : 'refund.succeeded');
    this.eventCounter += 1;
    const body: PaymentWebhookInput = {
      id: options.eventId ?? `evt_${refund.reference}_${type}_${this.eventCounter}`,
      type,
      sequence: options.sequence ?? refund.sequence,
      data: {
        organizationId: refund.metadata.organizationId,
        providerReference: refund.reference,
        refundAttemptId: refund.metadata.refundAttemptId,
        amountMinor: options.amountMinor ?? refund.amountMinor,
        currency: options.currency ?? refund.currency,
        ...(type === 'refund.failed'
          ? { failureReason: refund.failureReason ?? 'refund_rejected' }
          : {}),
      },
    };
    return { body, signature: FakePaymentProvider.sign(body) };
  }

  static sign(body: unknown): string {
    return createHmac('sha256', FAKE_PAYMENTS_WEBHOOK_SECRET)
      .update(stableStringify(body))
      .digest('hex');
  }

  static verify(body: unknown, signature: string | undefined): boolean {
    if (!signature) return false;
    const expected = Buffer.from(FakePaymentProvider.sign(body), 'utf8');
    const given = Buffer.from(signature, 'utf8');
    return expected.length === given.length && timingSafeEqual(expected, given);
  }

  private paymentResult(charge: FakeCharge): ProviderPaymentResult {
    return {
      providerReference: charge.reference,
      status: charge.status,
      amountMinor: charge.amountMinor,
      currency: charge.currency,
      feeMinor: charge.status === 'succeeded' ? charge.feeMinor : null,
      actionPayload: charge.actionPayload,
      failureReason: charge.failureReason,
    };
  }

  private refundResult(refund: FakeRefund): ProviderRefundResult {
    return {
      providerReference: refund.reference,
      status: refund.status,
      amountMinor: refund.amountMinor,
      currency: refund.currency,
      failureReason: refund.failureReason,
    };
  }
}

function paymentEventType(status: ProviderPaymentStatus): PaymentWebhookInput['type'] {
  switch (status) {
    case 'succeeded':
      return 'payment.succeeded';
    case 'failed':
      return 'payment.failed';
    case 'canceled':
      return 'payment.canceled';
    case 'requires_action':
      return 'payment.requires_action';
    case 'processing':
      return 'payment.processing';
  }
}

/** Key-order independent JSON so the signature survives re-serialization. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(',')}}`;
}
