/**
 * A button that sends a command (§4.9). Offline the competition screens are read-only
 * (SPK-UX-008, §4.15; SCR-S-09 "offline (disabled)"): the button is disabled and says that the
 * change needs a connection, so nothing looks queued or committed while it is not.
 */
import { useId } from 'react';
import { useApp } from '../../providers/AppProviders';
import { Button, type ButtonProps } from '../../ui/Button';

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
