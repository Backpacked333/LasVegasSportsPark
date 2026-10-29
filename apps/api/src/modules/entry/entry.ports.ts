import { z, type ObservedState } from '@sportspark/contracts';
import type { Trx } from '../../kernel';

/**
 * Ports of the entry module (README "Ports").
 *
 * Consumed (filled by other modules later):
 *   - FINANCIAL_STANDING_PORT: finance registers FINANCIAL_STANDING_IMPL. Until then every standing
 *     is `unknown`, which is shown as an informational issue and never blocks (SPK-ENTRY-004).
 * Provided (for reporting, enrollment trials and the Today workspace):
 *   - ATTENDANCE_PORT: the current attendance of an activity and whether a person is on site.
 */

export type FinancialStanding =
  | { status: 'clear' }
  | {
      status: 'outstanding';
      /** True when the balance belongs to the activity being entered (its own enrollment or booking). */
      related: boolean;
      amountMinor: number;
      currency: string;
      reference: string | null;
    }
  | { status: 'unknown'; explanation: string };

export interface FinancialStandingPort {
  standingOf(
    organizationId: string,
    personId: string,
    context: { offeringId: string | null; at: Date },
    trx?: Trx,
  ): Promise<FinancialStanding>;
}
export const FINANCIAL_STANDING_PORT = Symbol('FINANCIAL_STANDING_PORT');
export const FINANCIAL_STANDING_IMPL = Symbol('FINANCIAL_STANDING_IMPL');

/** Fallback until finance registers FINANCIAL_STANDING_IMPL: no standing is asserted. */
export const unknownFinancialStanding: FinancialStandingPort = {
  standingOf: async () => ({
    status: 'unknown',
    explanation: 'No finance module is registered: the financial standing is not known.',
  }),
};

export interface EffectiveAttendance {
  personId: string;
  /** Null when nothing is recorded or the current observations conflict (pending review). */
  state: ObservedState | null;
  conflict: boolean;
}

export interface AttendancePort {
  effectiveAttendance(
    organizationId: string,
    activityType: 'session' | 'event',
    activityId: string,
    trx?: Trx,
  ): Promise<EffectiveAttendance[]>;
  /** The person's open visit at the facility, or null (arrival is not attendance, SPK-ENTRY-001). */
  openVisitOf(
    organizationId: string,
    facilityId: string,
    personId: string,
    trx?: Trx,
  ): Promise<{ visitId: string; arrivedAt: Date } | null>;
}
export const ATTENDANCE_PORT = Symbol('ATTENDANCE_PORT');

// ---------------------------------------------------------------------------------------------
// Access hardware (ENT-05, IF-38; §3.16 Access hardware, SPK-COND-004, §5.2 hardware gate)
// ---------------------------------------------------------------------------------------------

/** A command for one access device; a missing policy means deny-all. */
export interface AccessDeviceCommand {
  organizationId: string;
  /** The provider's reference of the device. */
  deviceRef: string;
  /** Deduplication key: the device applies one command once. */
  commandId: string;
  kind: 'revoke_credential' | 'sync_policy';
  payload: { passReferenceHash?: string; policy?: Record<string, unknown> };
}

export type AccessDeviceCommandResult =
  { outcome: 'delivered' } | { outcome: 'failed' | 'unknown'; error: string };

/**
 * Commands to access devices (the hardware vendor is not selected, DEC-023). Called OUTSIDE any
 * database transaction (§4.11); never throws for an outcome: a lost answer is `unknown` and the
 * device's receipt (inbox type `device.command_receipt`) settles it. The deterministic
 * `FakeAccessControlProvider` is the only adapter (success, failure, timeout with an unknown
 * outcome, duplicate receipts).
 */
export interface AccessDevicePort {
  readonly name: string;
  sendCommand(command: AccessDeviceCommand): Promise<AccessDeviceCommandResult>;
}
export const ACCESS_DEVICE_PORT = Symbol('ACCESS_DEVICE_PORT');

/** Fake provider inbox payloads ENT-05 ingests (`device.heartbeat`, `device.command_receipt`). */
export const DeviceHeartbeatSchema = z.object({ deviceRef: z.string().min(1), at: z.string() });
export const DeviceCommandReceiptSchema = z.object({
  commandId: z.string().min(1),
  outcome: z.enum(['delivered', 'failed']),
});
