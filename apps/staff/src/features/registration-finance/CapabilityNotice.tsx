/**
 * The capability switch as a notice only (§6.5 Package G; K-12, DEC-016, DEC-072 to DEC-082), for
 * records and commands the API never turns off: membership suspensions and their end (ENR-12),
 * session package reads and redemption reversals (ENR-11). Unlike `CapabilityGate`, the children
 * always render, whatever `GET /v1/me/permissions` answers: while it loads, fails or is offline
 * nothing is taken away from staff, and the "turned off" notice appears above the children only
 * once the API says the switch is off. The API still answers each command; a CAPABILITY_DISABLED
 * refusal is shown as turned off by `CommandError`.
 */
import { CAPABILITY_PRESENTATION, type CapabilityId } from '@sportspark/api-client';
import type { ReactNode } from 'react';
import { usePermissions } from '../../api/permissions';
import { StateView } from '../../ui/StateView';

export function CapabilityNotice({
  capability,
  stillAvailable,
  children,
}: {
  capability: CapabilityId;
  /** What stays available while the switch is off. */
  stillAvailable: string;
  children: ReactNode;
}) {
  const permissions = usePermissions();
  const presentation = CAPABILITY_PRESENTATION[capability];
  const off = permissions.isCapabilityEnabled(capability) === false;
  return (
    <>
      {off ? (
        <StateView
          variant="turned-off"
          subject={presentation.label}
          decisions={presentation.decisions}
          owner={presentation.owner}
          stillAvailable={stillAvailable}
        />
      ) : null}
      {children}
    </>
  );
}
