/**
 * A button that sends a command (§4.9). Offline a command is never queued unannounced (§4.15: only
 * arrivals and first attendance observations are queued, by the offline queue, never by a paused
 * request; journeys.md section 3, "never pretend a queued action is committed"): the button is
 * disabled and says that the change needs a connection, so nothing looks sent, queued or committed
 * while it is not, and what the user typed stays in the form. Used by the competition screens
 * (SCR-S-09 "offline (disabled)"), the assignment screens (SCR-S-33, SCR-W-01), the assessments
 * (SCR-W-07 "offline (draft kept)") and the "Try again" of the shared command failure views
 * (`ui/CommandOutcome`, `ui/StateView`), so a retry offline is never a control that does nothing.
 */
import { useId } from 'react';
import { useOnline } from '../providers/AppProviders';
import { Button, type ButtonProps } from './Button';

export function CommandButton({ disabled, children, ...rest }: ButtonProps) {
  const online = useOnline();
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
