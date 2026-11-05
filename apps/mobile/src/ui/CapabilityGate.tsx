/**
 * CapabilityGate: renders its children only while the organization has the conditional capability
 * turned on (§1.6, §6.5 Package G; K-12, DEC-016 and DEC-072 to DEC-082). Every switch starts off.
 *
 * - While `GET /v1/me/permissions` loads: the loading state. If it fails with nothing cached: the
 *   error (code, "Try again"), "not available", or the offline state; never a guess either way.
 *   With `whenOff="notice"` the children render under the loading, error and offline states too:
 *   what the customer already has never depends on the switch, so it follows its own read states
 *   (a refused permissions read, "not available", shows nothing else).
 * - Off: the "turned off" state naming the decisions that may turn it on (the same words as a
 *   command refused with CAPABILITY_DISABLED, and as the staff app). `whenOff="notice"` shows that
 *   state above the children instead of replacing them, for screens of what the customer already
 *   has, which the API keeps readable while a switch is off (reads, cancellations and ends are
 *   never gated).
 * - On: the children, which still render ACCESS_DENIED and protected NOT_FOUND as "not available".
 *
 * Several capabilities: the children render when any of them is on (one booking flow serves
 * rentals and parties); the API still refuses a command of the kind that is off.
 */
import {
  CAPABILITY_PRESENTATION,
  presentationForError,
  type CapabilityId,
} from '@sportspark/api-client';
import type { ReactNode } from 'react';
import { usePermissions } from '../api/permissions';
import { useConnectivity, useNow } from '../providers/AppProviders';
import { StateView } from './StateView';

export interface CapabilityGateProps {
  capability: CapabilityId | readonly CapabilityId[];
  /** What is gated, e.g. "Rentals and parties"; default: the capabilities' labels. */
  subject?: string;
  whenOff?: 'block' | 'notice';
  /** With `whenOff="notice"`: what stays available, e.g. "Bookings you made stay listed here." */
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
  const { reachable } = useConnectivity();
  const now = useNow();
  const ids: readonly CapabilityId[] = typeof capability === 'string' ? [capability] : capability;
  const label = subject ?? ids.map((id) => CAPABILITY_PRESENTATION[id].label).join(' and ');
  const { query } = permissions;

  if (query.data === undefined) {
    const retry = () => void query.refetch();
    let unknown: ReactNode;
    if (query.error) {
      const presentation = presentationForError(query.error);
      // The API refused this account its own permissions: nothing is shown under it.
      if (presentation === 'unavailable') return <StateView variant="unavailable" />;
      unknown =
        presentation === 'offline' ? (
          <StateView variant="offline-stale" offline updatedAt={null} now={now} onRetry={retry} />
        ) : (
          <StateView variant="error" error={query.error} onRetry={retry} />
        );
    } else if (query.fetchStatus === 'paused' || reachable === false) {
      unknown = (
        <StateView variant="offline-stale" offline updatedAt={null} now={now} onRetry={retry} />
      );
    } else {
      unknown = (
        <StateView variant="loading" label={`whether ${label.toLowerCase()} is turned on`} />
      );
    }
    // What the customer already has is readable whatever the switch says (reads are never gated,
    // §1.6): with `whenOff="notice"` it follows its own read states under the unknown switch.
    return whenOff === 'notice' ? <Noticed notice={unknown}>{children}</Noticed> : unknown;
  }

  if (ids.some((id) => permissions.isCapabilityEnabled(id) === true)) {
    // The same tree as the notice states, so the children are not mounted again (their reads and
    // what the person was doing are kept) when the switch's state arrives or changes.
    return whenOff === 'notice' ? <Noticed notice={null}>{children}</Noticed> : <>{children}</>;
  }

  const turnedOff = (
    <StateView
      variant="turned-off"
      subject={label}
      decisions={unique(ids.flatMap((id) => CAPABILITY_PRESENTATION[id].decisions))}
      owner={ids[0] ? CAPABILITY_PRESENTATION[ids[0]].owner : undefined}
      stillAvailable={whenOff === 'notice' ? stillAvailable : undefined}
    />
  );
  if (whenOff === 'notice') return <Noticed notice={turnedOff}>{children}</Noticed>;
  return turnedOff;
}

/** A notice slot above the children, with the children always in the same place. */
function Noticed({ notice, children }: { notice: ReactNode; children: ReactNode }) {
  return (
    <>
      {notice}
      {children}
    </>
  );
}
