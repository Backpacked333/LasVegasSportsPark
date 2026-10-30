/**
 * Which commands SCR-S-55, SCR-S-56 and SCR-S-57 offer, from the role view the API gives
 * (`GET /v1/me/permissions`, K-05; SPK-UX-005, SPK-UX-008 "permission restriction"). These records
 * carry no per-record `availableActions`; the permission read says which actions the viewer's
 * staff roles allow, and at which facilities.
 *
 * A command is offered unless the read says it is not allowed (at this facility); while the read is
 * unknown nothing is hidden, and the command's own ACCESS_DENIED still decides (`CommandError`
 * says it is not available to you). This never grants anything the API would refuse. Whether the
 * organization's switch is on comes from the same read: commands that start a new commitment are
 * not offered while it is off (DEC-016), while retirements, voids, returns, closing a session and
 * canceling a batch stay offered because the API never gates them.
 */
import type { CapabilityId } from '@sportspark/api-client';
import { usePermissions } from '../../api/permissions';
import { StateView } from '../../ui/StateView';

/** finance.actions.ts (FIN-06, FIN-07) and entry.actions.ts (ENT-05) in apps/api. */
export const POS_ACTIONS = {
  manageProducts: 'finance.manage_pos_products',
  manageRegisters: 'finance.manage_pos_registers',
  operateRegister: 'finance.operate_register',
  approveReturn: 'finance.approve_pos_return',
} as const;

export const ACCOUNTING_ACTIONS = {
  manageMappings: 'finance.manage_accounting_mappings',
  approveMapping: 'finance.approve_accounting_mapping',
  exportAccounting: 'finance.export_accounting',
} as const;

export const ACCESS_ACTIONS = {
  registerDevice: 'entry.register_access_device',
  updateDevice: 'entry.update_access_device',
  retireDevice: 'entry.retire_access_device',
  draftPolicy: 'entry.draft_access_policy',
  approvePolicy: 'entry.approve_access_policy',
  retirePolicy: 'entry.retire_access_policy',
} as const;

export interface Offer {
  /** False only when the permission read says the action is not allowed (at the facility). */
  allowed(actionId: string, facilityId?: string | null): boolean;
  /** False only when the permission read says the switch is off. */
  capabilityOn(capability: CapabilityId): boolean;
}

export function useOffer(): Offer {
  const permissions = usePermissions();
  return {
    allowed: (actionId, facilityId) =>
      permissions.isPermitted(actionId, facilityId ?? null) !== false,
    capabilityOn: (capability) => permissions.isCapabilityEnabled(capability) !== false,
  };
}

/** "Not available to you", naming the permission so staff know what to ask for (§4.10). */
export function NotAvailableToYou({ what, action }: { what: string; action: string }) {
  return (
    <StateView
      variant="unavailable"
      title="Not available to you"
      description={`${what} is not available to you here. Your role does not include the permission ${action}. Ask an administrator if you need it.`}
    />
  );
}
