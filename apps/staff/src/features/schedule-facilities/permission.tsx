/**
 * Which schedule and facilities commands to offer, from the role view the API gives
 * (`GET /v1/me/permissions`, K-05; SPK-UX-005, SPK-UX-008 "permission restriction"). The API has no
 * per-record `availableActions` for drafts, closures, tasks or restrictions; the permission read
 * says which actions the viewer's staff roles allow at a facility.
 *
 * A command is offered unless the read says it is not allowed at this facility; while the read is
 * loading or has failed nothing is hidden, and the command's own ACCESS_DENIED still decides
 * (`CommandError` names the missing permission). This never grants anything the API would refuse.
 */
import type { ReactNode } from 'react';
import { usePermissions } from '../../api/permissions';
import { StateView } from '../../ui/StateView';

/** False only when the API's permission read says the action is not allowed at the facility. */
export function useActionAllowed(actionId: string, facilityId: string | null | undefined) {
  const permissions = usePermissions();
  return permissions.isPermitted(actionId, facilityId ?? null) !== false;
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

/** Renders `children` unless the action is not allowed at the facility; then says so. */
export function ActionGate({
  action,
  facilityId,
  what,
  children,
}: {
  action: string;
  facilityId: string | null | undefined;
  /** e.g. "Creating closures". */
  what: string;
  children: ReactNode;
}) {
  const allowed = useActionAllowed(action, facilityId);
  return allowed ? <>{children}</> : <NotAvailableToYou what={what} action={action} />;
}
