/**
 * A button that sends a command (§4.9). Offline a command is never queued unannounced (§4.15: only
 * arrivals and first attendance observations are queued, by the offline queue, never by a paused
 * request; journeys.md section 3, "never pretend a queued action is committed"): the button is
 * disabled and says that the change needs a connection, so nothing looks sent, queued or committed
 * while it is not. Used by the competition screens (SCR-S-09 "offline (disabled)") and the
 * assignment screens (SCR-S-33, SCR-W-01).
 */
import { useId } from 'react';
import { useApp } from '../providers/AppProviders';
import { Button, type ButtonProps } from './Button';

export function CommandButton({ disabled, children, ...rest }: ButtonProps) {
  const { online } = useApp();
  const hintId = useId();
  return (
    <>
      <Button
        {...rest}
        disabled={disabled || !online}
        aria-describedby={!online ? hintId : rest['aria-describedby']}
      >
        {children}
      </Button>
      {!online ? (
        <span className="caption" id={hintId}>
          Needs a connection.
        </span>
      ) : null}
    </>
  );
}
