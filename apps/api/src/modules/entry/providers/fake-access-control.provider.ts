import { createHmac, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { AccessControlEventBody, VisitorCategory } from '@sportspark/contracts';

/**
 * Deterministic fake access-control provider (specification §5.2: hardware vendors are not
 * selected, DEC-023; §3.16 "Access hardware": event ingestion, outages, audit). It produces the
 * signed webhook events a door controller or turnstile would post. Scenarios:
 *   - `granted`: the device let the credential through (success);
 *   - `denied`: the device refused the credential (failure);
 *   - `unknown`: the device lost contact before it knew the outcome (timeout/unknown);
 *   - duplicates: posting the same event body twice (the inbox records it once).
 * Event ids are deterministic (device + counter) unless given, so tests can assert on them.
 */
export const FAKE_ACCESS_CONTROL_PROVIDER = 'fake-access-control';
/** Test-only shared secret; a real provider's secret would arrive through the environment. */
export const FAKE_ACCESS_CONTROL_WEBHOOK_SECRET = 'fake-access-control-webhook-secret';
export const FAKE_ACCESS_CONTROL_SIGNATURE_HEADER = 'x-access-control-signature';

export interface FakeAccessEventInput {
  organizationId: string;
  facilityId: string;
  deviceId?: string;
  occurredAt: string;
  passReference?: string;
  personId?: string;
  visitorCategory?: VisitorCategory;
  eventId?: string;
}

@Injectable()
export class FakeAccessControlProvider {
  readonly name = FAKE_ACCESS_CONTROL_PROVIDER;
  private counter = 0;

  granted(input: FakeAccessEventInput): { body: AccessControlEventBody; signature: string } {
    return this.event('access.granted', input);
  }

  denied(input: FakeAccessEventInput): { body: AccessControlEventBody; signature: string } {
    return this.event('access.denied', input);
  }

  unknown(input: FakeAccessEventInput): { body: AccessControlEventBody; signature: string } {
    return this.event('access.unknown', input);
  }

  private event(
    type: AccessControlEventBody['type'],
    input: FakeAccessEventInput,
  ): { body: AccessControlEventBody; signature: string } {
    this.counter += 1;
    const deviceId = input.deviceId ?? 'turnstile-1';
    const body: AccessControlEventBody = {
      id: input.eventId ?? `${deviceId}-${type}-${this.counter}`,
      type,
      data: {
        organizationId: input.organizationId,
        facilityId: input.facilityId,
        deviceId,
        occurredAt: input.occurredAt,
        ...(input.passReference ? { passReference: input.passReference } : {}),
        ...(input.personId ? { personId: input.personId } : {}),
        ...(input.visitorCategory ? { visitorCategory: input.visitorCategory } : {}),
      },
    };
    return { body, signature: FakeAccessControlProvider.sign(body) };
  }

  static sign(body: unknown): string {
    return createHmac('sha256', FAKE_ACCESS_CONTROL_WEBHOOK_SECRET)
      .update(stableStringify(body))
      .digest('hex');
  }

  static verify(body: unknown, signature: string | undefined): boolean {
    if (!signature) return false;
    const expected = Buffer.from(FakeAccessControlProvider.sign(body), 'utf8');
    const given = Buffer.from(signature, 'utf8');
    return expected.length === given.length && timingSafeEqual(expected, given);
  }
}

/** Key-order independent JSON so the signature survives re-serialization. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(',')}}`;
}
