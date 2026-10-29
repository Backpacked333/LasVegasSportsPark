import { createHmac, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type {
  AccessControlEventBody,
  DeviceCommandReceiptEventBody,
  DeviceHeartbeatEventBody,
  VisitorCategory,
} from '@sportspark/contracts';
import type {
  AccessDeviceCommand,
  AccessDeviceCommandResult,
  AccessDevicePort,
} from '../entry.ports';

/**
 * Deterministic fake access-control provider (specification §5.2: hardware vendors are not
 * selected, DEC-023; §3.16 "Access hardware": event ingestion, outages, audit). It produces the
 * signed webhook events a door controller or turnstile would post. Scenarios:
 *   - `granted`: the device let the credential through (success);
 *   - `denied`: the device refused the credential (failure);
 *   - `unknown`: the device lost contact before it knew the outcome (timeout/unknown);
 *   - duplicates: posting the same event body twice (the inbox records it once).
 * Event ids are deterministic (device + counter) unless given, so tests can assert on them.
 *
 * ENT-05 (IF-38): it is also the AccessDevicePort adapter (`sendCommand`, scripted per call), and
 * produces the device's own signals for the inbox: `device.heartbeat` and `device.command_receipt`
 * (a receipt settles a command once; posting it again is the duplicate scenario).
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

/**
 * Scripted behaviour of the next NEW device commands (default `deliver`): `fail` (the device
 * refused it), `timeout` (no answer: the outcome is unknown until a receipt arrives).
 */
export type FakeDeviceCommandOutcome = 'deliver' | 'fail' | 'timeout';

@Injectable()
export class FakeAccessControlProvider implements AccessDevicePort {
  readonly name = FAKE_ACCESS_CONTROL_PROVIDER;
  private counter = 0;
  private readonly commandScript: FakeDeviceCommandOutcome[] = [];
  private readonly commandResults = new Map<string, AccessDeviceCommandResult>();
  /** Every sendCommand call, including repeats (tests assert on it). */
  readonly commandCalls: AccessDeviceCommand[] = [];

  /** The next new commands, in order, behave like this (IF-38). */
  scriptCommands(...outcomes: FakeDeviceCommandOutcome[]): void {
    this.commandScript.push(...outcomes);
  }

  /**
   * AccessDevicePort.sendCommand (IF-38): a repeated command id returns the first outcome (the
   * device applies a command once); never throws for an outcome.
   */
  async sendCommand(command: AccessDeviceCommand): Promise<AccessDeviceCommandResult> {
    this.commandCalls.push(command);
    const key = `${command.organizationId}:${command.deviceRef}:${command.commandId}`;
    const earlier = this.commandResults.get(key);
    if (earlier) return earlier;
    const outcome = this.commandScript.shift() ?? 'deliver';
    const result: AccessDeviceCommandResult =
      outcome === 'deliver'
        ? { outcome: 'delivered' }
        : outcome === 'fail'
          ? { outcome: 'failed', error: 'fake device: the command was refused' }
          : { outcome: 'unknown', error: 'fake device: no answer within the timeout' };
    // A lost answer is not remembered as an outcome: a retry may still be delivered.
    if (outcome !== 'timeout') this.commandResults.set(key, result);
    return result;
  }

  granted(input: FakeAccessEventInput): { body: AccessControlEventBody; signature: string } {
    return this.event('access.granted', input);
  }

  denied(input: FakeAccessEventInput): { body: AccessControlEventBody; signature: string } {
    return this.event('access.denied', input);
  }

  unknown(input: FakeAccessEventInput): { body: AccessControlEventBody; signature: string } {
    return this.event('access.unknown', input);
  }

  /** IF-38 `device.heartbeat`: the device is alive at `at`. */
  heartbeat(input: { organizationId: string; deviceRef: string; at: string; eventId?: string }): {
    body: DeviceHeartbeatEventBody;
    signature: string;
  } {
    this.counter += 1;
    const body: DeviceHeartbeatEventBody = {
      id: input.eventId ?? `${input.deviceRef}-device.heartbeat-${this.counter}`,
      type: 'device.heartbeat',
      data: { organizationId: input.organizationId, deviceRef: input.deviceRef, at: input.at },
    };
    return { body, signature: FakeAccessControlProvider.sign(body) };
  }

  /** IF-38 `device.command_receipt`: the device's own answer about a command it received. */
  commandReceipt(input: {
    organizationId: string;
    commandId: string;
    outcome: 'delivered' | 'failed';
    eventId?: string;
  }): { body: DeviceCommandReceiptEventBody; signature: string } {
    this.counter += 1;
    const body: DeviceCommandReceiptEventBody = {
      id: input.eventId ?? `${input.commandId}-device.command_receipt-${this.counter}`,
      type: 'device.command_receipt',
      data: {
        organizationId: input.organizationId,
        commandId: input.commandId,
        outcome: input.outcome,
      },
    };
    return { body, signature: FakeAccessControlProvider.sign(body) };
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
