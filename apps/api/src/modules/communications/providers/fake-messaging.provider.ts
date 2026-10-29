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
 *   - success (default): accepted with a deterministic provider message id;
 *   - failure: an address containing `+fail` (or a scripted `failed`) is rejected;
 *   - timeout/unknown: an address containing `+unknown` (or scripted `unknown`) yields no
 *     trustworthy outcome; scripted `throw` makes the adapter itself blow up (the worker records
 *     `unknown`);
 *   - duplicate: a second hand-off of an attempt the provider already accepted is answered with
 *     the same provider message id and sends nothing again (provider-side idempotency keyed on the
 *     attempt id), and `receipt()` with a repeated event id is the duplicate webhook the kernel
 *     inbox records once.
 * The push fake fans out per device (COM-01): each of the request's `addresses` is one device,
 * with its own outcome by address; the message is accepted when any device accepted it, unknown
 * when none accepted and any is unknown, and failed only when every device rejected it.
 * Receipts are produced with `receipt()` as the signed webhook a real provider would post.
 */
export type FakeOutcome = 'accepted' | 'failed' | 'unknown' | 'throw';
export type FakeDeviceOutcome = Exclude<FakeOutcome, 'throw'>;

/** One device a push hand-off reached (the fake push provider's per-device fan-out). */
export interface FakeDeviceSend {
  attemptId: string;
  address: string;
  outcome: FakeDeviceOutcome;
}

export const FAKE_MESSAGING_PROVIDER = 'fake-messaging';
/** Test-only shared secret for webhook signatures; a real provider's secret arrives via the environment. */
export const FAKE_MESSAGING_WEBHOOK_SECRET = 'fake-messaging-webhook-secret';
export const FAKE_MESSAGING_SIGNATURE_HEADER = 'x-messaging-signature';

export class FakeMessagingProvider implements ChannelProviderPort {
  readonly name = FAKE_MESSAGING_PROVIDER;
  /** Every request handed to the provider, in order (tests assert on it). */
  readonly sent: ChannelSendRequest[] = [];
  /** Every device or address a send reached, with its outcome (the fan-out of `sent`). */
  readonly deviceSends: FakeDeviceSend[] = [];
  private readonly scripted: FakeOutcome[] = [];
  private readonly byAddress = new Map<string, FakeOutcome>();
  /** Attempts the provider accepted (duplicate scenario: a second hand-off sends nothing). */
  private readonly accepted = new Set<string>();
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
    this.deviceSends.length = 0;
    this.scripted.length = 0;
    this.byAddress.clear();
    this.accepted.clear();
  }

  async send(request: ChannelSendRequest): Promise<ChannelSendResult> {
    this.sent.push(request);
    const providerMessageId = FakeMessagingProvider.messageIdFor(this.channel, request.attemptId);
    if (this.accepted.has(request.attemptId)) {
      // Duplicate hand-off of an accepted attempt: the provider deduplicates on the attempt id.
      return {
        outcome: 'accepted',
        providerMessageId,
        response: { provider: this.name, channel: this.channel, accepted: true, duplicate: true },
      };
    }
    const addresses = request.addresses.length > 0 ? request.addresses : [request.address];
    const scripted = this.scripted.shift();
    if (scripted === 'throw') throw new Error('fake provider transport failure');
    const devices = addresses.map((address) => {
      const outcome = scripted ?? this.byAddress.get(address) ?? outcomeFor(address);
      // a per-address `throw` is a transport failure of that device's call: no trustworthy outcome
      const device: FakeDeviceOutcome = outcome === 'throw' ? 'unknown' : outcome;
      this.deviceSends.push({ attemptId: request.attemptId, address, outcome: device });
      return device;
    });
    const summary = {
      accepted: devices.filter((d) => d === 'accepted').length,
      failed: devices.filter((d) => d === 'failed').length,
      unknown: devices.filter((d) => d === 'unknown').length,
    };
    if (summary.accepted > 0) {
      this.accepted.add(request.attemptId);
      return {
        outcome: 'accepted',
        providerMessageId,
        response: { provider: this.name, channel: this.channel, accepted: true, devices: summary },
      };
    }
    if (summary.unknown > 0) {
      return {
        outcome: 'unknown',
        error: 'provider call timed out before an outcome was known (fake scenario)',
        response: { provider: this.name, channel: this.channel, devices: summary },
      };
    }
    return {
      outcome: 'failed',
      error: 'provider rejected the message (fake scenario)',
      response: { provider: this.name, channel: this.channel, accepted: false, devices: summary },
    };
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
