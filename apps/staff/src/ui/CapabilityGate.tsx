/**
 * CapabilityGate: renders its children only while the organization has the conditional capability
 * turned on (§1.6, §6.5 Package G; K-12, DEC-016 and DEC-072 to DEC-082). Every switch starts off.
 *
 * - While `GET /v1/me/permissions` loads: the loading state. If it fails with nothing cached: the
 *   error (code, "Try again") or the offline state, never a guess either way.
 * - Off: the "turned off" state naming the decisions that may turn it on (same words as the
 *   assistant panel's "turned off" and as a command refused with CAPABILITY_DISABLED).
 *   `whenOff="notice"` shows that state above the children instead of replacing them, for screens
 *   of existing records the API keeps readable while a switch is off (reads, cancellations, ends
 *   and reversals are never gated).
 * - On: the children, which still render ACCESS_DENIED and protected NOT_FOUND as "not available"
 *   (the switch is about the organization, not this principal's permissions).
 *
 * Several capabilities: the children render when any of them is on (a booking flow serves rentals
 * and parties); the API still refuses a command of the kind that is off.
 */
import {
  CAPABILITY_PRESENTATION,
  presentationForError,
  type CapabilityId,
} from '@sportspark/api-client';
import type { ReactNode } from 'react';
import { usePermissions } from '../api/permissions';
import { useApp, useNow } from '../providers/AppProviders';
import { StateView } from './StateView';

export interface CapabilityGateProps {
  capability: CapabilityId | readonly CapabilityId[];
  /** What is gated, e.g. "Rentals"; default: the capability's label. */
  subject?: string;
  whenOff?: 'block' | 'notice';
  /** With `whenOff="notice"`: what stays available, e.g. "Existing bookings stay listed." */
  stillAvailable?: string;
  children: ReactNode;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

export function CapabilityGate({
  capability,
  subject,
  whenOff = 'block',
  stillAvailable,
  children,
}: CapabilityGateProps) {
  const permissions = usePermissions();
  const { online } = useApp();
  const now = useNow();
  const ids: readonly CapabilityId[] = typeof capability === 'string' ? [capability] : capability;
  const label = subject ?? ids.map((id) => CAPABILITY_PRESENTATION[id].label).join(' and ');
  const { query } = permissions;

  if (query.data === undefined) {
    const retry = () => void query.refetch();
    if (query.error) {
      const presentation = presentationForError(query.error);
      if (presentation === 'unavailable') return <StateView variant="unavailable" />;
      if (presentation === 'offline') {
        return (
          <StateView variant="offline-stale" offline updatedAt={null} now={now} onRetry={retry} />
        );
      }
      return <StateView variant="error" error={query.error} onRetry={retry} />;
    }
    if (query.fetchStatus === 'paused' || !online) {
      return (
        <StateView variant="offline-stale" offline updatedAt={null} now={now} onRetry={retry} />
      );
    }
    return <StateView variant="loading" label={`whether ${label.toLowerCase()} is turned on`} />;
  }

  if (ids.some((id) => permissions.isCapabilityEnabled(id) === true)) return <>{children}</>;

  const turnedOff = (
    <StateView
      variant="turned-off"
      subject={label}
      decisions={unique(ids.flatMap((id) => CAPABILITY_PRESENTATION[id].decisions))}
      owner={ids[0] ? CAPABILITY_PRESENTATION[ids[0]].owner : undefined}
      stillAvailable={whenOff === 'notice' ? stillAvailable : undefined}
    />
  );
  if (whenOff === 'notice') {
    return (
      <>
        {turnedOff}
        {children}
      </>
    );
  }
  return turnedOff;
}
