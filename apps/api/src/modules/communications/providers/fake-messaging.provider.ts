import { createHmac, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { DeliveryReceiptStatus, MessagingWebhookInput } from '@sportspark/contracts';
import type {
  ChannelProviderPort,
  ChannelSendRequest,
  ChannelSendResult,
  ExternalChannel,
} from '../ports';

/**
 * Deterministic fake channel providers (specification §5.2: push, email and SMS vendors are not
 * selected, DEC-020). One class per channel so each can be scripted independently. Scenarios:
 *   - default: accepted with a deterministic provider message id;
 *   - address containing `+fail` (or a scripted `failed`): the provider rejects the message;
 *   - address containing `+unknown` (or scripted `unknown`): no trustworthy outcome;
 *   - scripted `throw`: the adapter itself blows up (the worker records `unknown`).
 * Receipts are produced with `receipt()` as the signed webhook a real provider would post.
 */
export type FakeOutcome = 'accepted' | 'failed' | 'unknown' | 'throw';

export const FAKE_MESSAGING_PROVIDER = 'fake-messaging';
/** Test-only shared secret for webhook signatures; a real provider's secret arrives via the environment. */
export const FAKE_MESSAGING_WEBHOOK_SECRET = 'fake-messaging-webhook-secret';
export const FAKE_MESSAGING_SIGNATURE_HEADER = 'x-messaging-signature';

export class FakeMessagingProvider implements ChannelProviderPort {
  readonly name = FAKE_MESSAGING_PROVIDER;
  /** Every request handed to the provider, in order (tests assert on it). */
  readonly sent: ChannelSendRequest[] = [];
  private readonly scripted: FakeOutcome[] = [];
  private readonly byAddress = new Map<string, FakeOutcome>();
  private receiptCounter = 0;

  constructor(readonly channel: ExternalChannel) {}

  /** The next calls, in order, produce these outcomes regardless of address. */
  scriptNext(...outcomes: FakeOutcome[]): void {
    this.scripted.push(...outcomes);
  }

  scriptAddress(address: string, outcome: FakeOutcome): void {
    this.byAddress.set(address, outcome);
  }

  reset(): void {
    this.sent.length = 0;
    this.scripted.length = 0;
    this.byAddress.clear();
  }

  async send(request: ChannelSendRequest): Promise<ChannelSendResult> {
    this.sent.push(request);
    const outcome =
      this.scripted.shift() ?? this.byAddress.get(request.address) ?? outcomeFor(request.address);
    switch (outcome) {
      case 'accepted':
        return {
          outcome: 'accepted',
          providerMessageId: FakeMessagingProvider.messageIdFor(this.channel, request.attemptId),
          response: { provider: this.name, channel: this.channel, accepted: true },
        };
      case 'failed':
        return {
          outcome: 'failed',
          error: 'provider rejected the message (fake scenario)',
          response: { provider: this.name, channel: this.channel, accepted: false },
        };
      case 'unknown':
        return {
          outcome: 'unknown',
          error: 'provider call timed out before an outcome was known (fake scenario)',
        };
      case 'throw':
        throw new Error('fake provider transport failure');
    }
  }

  static messageIdFor(channel: ExternalChannel, attemptId: string): string {
    return `${channel}-${attemptId}`;
  }

  /** The signed webhook a provider would post about an attempt (deterministic event ids). */
  receipt(
    request: Pick<ChannelSendRequest, 'attemptId' | 'organizationId'>,
    status: DeliveryReceiptStatus,
    options: { error?: string | null; eventId?: string; occurredAt?: string } = {},
  ): { body: MessagingWebhookInput; signature: string } {
    this.receiptCounter += 1;
    const body: MessagingWebhookInput = {
      id:
        options.eventId ?? `${this.channel}-${request.attemptId}-${status}-${this.receiptCounter}`,
      type: 'delivery.receipt',
      data: {
        attemptId: request.attemptId,
        organizationId: request.organizationId,
        providerMessageId: FakeMessagingProvider.messageIdFor(this.channel, request.attemptId),
        status,
        error: options.error ?? null,
        ...(options.occurredAt ? { occurredAt: options.occurredAt } : {}),
      },
    };
    return { body, signature: FakeMessagingProvider.sign(body) };
  }

  static sign(body: unknown): string {
    return createHmac('sha256', FAKE_MESSAGING_WEBHOOK_SECRET)
      .update(stableStringify(body))
      .digest('hex');
  }

  static verify(body: unknown, signature: string | undefined): boolean {
    if (!signature) return false;
    const expected = Buffer.from(FakeMessagingProvider.sign(body), 'utf8');
    const given = Buffer.from(signature, 'utf8');
    return expected.length === given.length && timingSafeEqual(expected, given);
  }
}

function outcomeFor(address: string): FakeOutcome {
  if (address.includes('+fail')) return 'failed';
  if (address.includes('+unknown')) return 'unknown';
  return 'accepted';
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

@Injectable()
export class FakePushProvider extends FakeMessagingProvider {
  constructor() {
    super('push');
  }
}

@Injectable()
export class FakeEmailProvider extends FakeMessagingProvider {
  constructor() {
    super('email');
  }
}

@Injectable()
export class FakeSmsProvider extends FakeMessagingProvider {
  constructor() {
    super('sms');
  }
}
