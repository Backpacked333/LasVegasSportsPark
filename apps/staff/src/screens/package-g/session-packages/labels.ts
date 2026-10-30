/**
 * Session package states for staff (SCR-S-54; ENR-11, SPK-COND-002): the machine state names of
 * `package_entitlements` (active, exhausted, expired, revoked) through `StatusBadge`, and what a
 * canceled package booking did with its credit (`SessionBooking.creditDisposition`, POL-007,
 * POL-039: no automatic return without an approved policy).
 */
import type { Schema } from '@sportspark/api-client';
import type { StatusTone } from '../../../ui/StatusBadge';

export type PackageEntitlement = Schema<'PackageEntitlement'>;
export type PackageStatus = PackageEntitlement['status'];

export const PACKAGE_STATUS: Record<PackageStatus, { tone: StatusTone; label: string }> = {
  active: { tone: 'success', label: 'active' },
  exhausted: { tone: 'neutral', label: 'exhausted' },
  expired: { tone: 'neutral', label: 'expired' },
  revoked: { tone: 'danger', label: 'revoked' },
};

export const PACKAGE_STATUSES = Object.keys(PACKAGE_STATUS) as PackageStatus[];

export const CREDIT_DISPOSITION: Record<Schema<'SessionBookingCreditDisposition'>, string> = {
  returned: 'credit returned',
  retained_by_policy: 'credit kept under the approved cancellation policy',
  retained_pending_policy:
    'credit kept: no approved policy returns it (POL-007, POL-039 pending); staff may reverse the redemption',
};
