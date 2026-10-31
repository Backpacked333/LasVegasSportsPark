/**
 * Which Package G commands to offer (SCR-S-51 to SCR-S-54), from the role view the API gives
 * (`GET /v1/me/permissions`, K-05; SPK-UX-005, SPK-UX-008 "permission restriction"). Bookings,
 * memberships and packages carry no per-record `availableActions`; the permission read says which
 * actions the viewer's staff roles allow at a facility.
 *
 * A command is offered unless the read says it is not allowed at this facility; while the read is
 * loading or has failed nothing is hidden, and the command's own ACCESS_DENIED still decides
 * (`CommandError` names the missing permission). This never grants anything the API would refuse.
 * Whether a capability is on comes from the same read (`isCapabilityEnabled`); new commitments
 * (a booking, an approval, a renewal, a redemption) are not offered while it is off (DEC-016), and
 * the API's CAPABILITY_DISABLED answer still shows "turned off" if the switch changed meanwhile.
 */
import type { CapabilityId } from '@sportspark/api-client';
import { usePermissions } from '../../../api/permissions';
import { StateView } from '../../../ui/StateView';

/**
 * The actions behind these screens (apps/api enrollment.actions.ts; the staff coverage of a
 * booking is the workforce read, workforce.actions.ts).
 */
export const ACTIONS = {
  readBooking: 'enrollment.read_booking',
  readSessionBooking: 'enrollment.read_session_booking',
  viewAssignments: 'workforce.view_assignments',
  requestBooking: 'enrollment.request_booking',
  decideBooking: 'enrollment.decide_booking',
  readPackage: 'enrollment.read_package_entitlement',
  reverseRedemption: 'enrollment.reverse_package_redemption',
  bookSession: 'enrollment.book_session',
  manageSuspension: 'enrollment.manage_membership_suspension',
  renewMembership: 'enrollment.renew_membership',
} as const;

/** False only when the API's permission read says the action is not allowed at the facility. */
export function useActionAllowed(actionId: string, facilityId: string | null | undefined): boolean {
  const permissions = usePermissions();
  return permissions.isPermitted(actionId, facilityId ?? null) !== false;
}

/** False only when the permission read says the capability is off (undefined: not known yet). */
export function useCapabilityOn(capability: CapabilityId): boolean {
  const permissions = usePermissions();
  return permissions.isCapabilityEnabled(capability) !== false;
}

/** "Not available to you", naming the permission (staff see which one, §4.10). */
export function NotAvailableToYou({ what, action }: { what: string; action: string }) {
  return (
    <StateView
      variant="unavailable"
      title="Not available to you"
      description={`${what} is not available to you at this facility. Your role does not include the permission ${action}. Ask an administrator if you need it.`}
    />
  );
}
