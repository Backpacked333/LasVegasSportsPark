/**
 * StateView: the SPK-UX-008 states a screen shows instead of (or above) its content, as defined in
 * docs/package-a/screen-and-journey-inventory.md section 3. Same variants and wording as the
 * customer app (SPK-UX-010 consistent terminology):
 *
 * - loading, empty, error (code, safe message, correlation reference, recovery action),
 * - offline-stale (age of what is shown, actions unavailable offline),
 * - unavailable (protected NOT_FOUND or ACCESS_DENIED: "not available", never "exists but denied"),
 * - pending-decision (names the DEC-### and owner; nothing invented).
 */
import { formatAge, recoveryActionFor, type ApiError } from '@sportspark/api-client';
import type { ReactNode } from 'react';
import { Button } from './Button';
import { StatusBadge } from './StatusBadge';

interface ActionProps {
  actionLabel?: string;
  onAction?: () => void;
}

export type StateViewProps =
  | { variant: 'loading'; label: string }
  | ({ variant: 'empty'; title: string; description: string } & ActionProps)
  | { variant: 'error'; error: ApiError; onRetry?: () => void; onAction?: () => void }
  | {
      variant: 'offline-stale';
      updatedAt: Date | null;
      now: Date;
      offline: boolean;
      unavailableActions?: string[];
      onRetry?: () => void;
    }
  | ({ variant: 'unavailable'; title?: string; description?: string } & ActionProps)
  | { variant: 'pending-decision'; subject: string; decisions: string[]; owner?: string };

export function StateView(props: StateViewProps) {
  return (
    <section className="state" aria-live="polite" data-testid={`state-${props.variant}`}>
      {body(props)}
    </section>
  );
}

function body(props: StateViewProps): ReactNode {
  switch (props.variant) {
    case 'loading':
      return (
        <p role="progressbar" aria-busy="true" aria-label={`Loading ${props.label}`}>
          Loading {props.label}…
        </p>
      );
    case 'empty':
      return (
        <>
          <h2>{props.title}</h2>
          <p>{props.description}</p>
          {props.actionLabel && props.onAction ? (
            <Button variant="secondary" onClick={props.onAction}>
              {props.actionLabel}
            </Button>
          ) : null}
        </>
      );
    case 'error': {
      const recovery = recoveryActionFor(props.error);
      const onClick = recovery.retry ? props.onRetry : props.onAction;
      return (
        <>
          <StatusBadge tone="danger" label="Something went wrong" />
          <p>{props.error.message}</p>
          <p className="caption">
            Error code: {props.error.code}
            {props.error.correlationId ? `. Reference: ${props.error.correlationId}` : ''}
          </p>
          {onClick ? <Button onClick={onClick}>{recovery.label}</Button> : <p>{recovery.label}</p>}
        </>
      );
    }
    case 'offline-stale': {
      const age = props.updatedAt ? formatAge(props.updatedAt, props.now) : null;
      return (
        <>
          <StatusBadge
            tone="warning"
            label={props.offline ? 'You are offline' : 'This information may be out of date'}
          />
          <p>
            {age
              ? `Showing information from ${age}.`
              : 'Nothing has been loaded yet. Connect to see this information.'}
          </p>
          {props.unavailableActions && props.unavailableActions.length > 0 ? (
            <p className="caption">Needs a connection: {props.unavailableActions.join(', ')}.</p>
          ) : null}
          {props.onRetry ? (
            <Button variant="secondary" onClick={props.onRetry}>
              Try again
            </Button>
          ) : null}
        </>
      );
    }
    case 'unavailable':
      return (
        <>
          <StatusBadge tone="neutral" label={props.title ?? 'Not available'} />
          <p>
            {props.description ??
              'This is not available. Check the link, or ask an administrator if you expected to see something here.'}
          </p>
          {props.actionLabel && props.onAction ? (
            <Button variant="secondary" onClick={props.onAction}>
              {props.actionLabel}
            </Button>
          ) : null}
        </>
      );
    case 'pending-decision':
      return (
        <>
          <StatusBadge tone="pending" label="Waiting on a decision" />
          <p>
            {props.subject} is not available yet: it depends on {props.decisions.join(', ')}, which
            {props.decisions.length === 1 ? ' has' : ' have'} not been decided
            {props.owner ? ` (owner: ${props.owner})` : ''}.
          </p>
        </>
      );
  }
}
