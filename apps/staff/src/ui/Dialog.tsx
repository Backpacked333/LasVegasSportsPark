/**
 * Centred modal dialog (redesign handoff S 3f decline with a reason, S 1b refund note): over a
 * dimmed page; Escape, the scrim or ✕ close it unless `locked` (a command is running); focus moves
 * in, stays there and returns to the control that opened it (`useFocusTrap`). Purely presentational:
 * the screen keeps the form state and the command.
 */
import { useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';
import { useFocusTrap } from './useFocusTrap';

export function Dialog({
  labelledBy,
  onClose,
  header,
  children,
  footer,
  locked = false,
  width = 520,
  testId,
}: {
  labelledBy: string;
  onClose: () => void;
  header: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  locked?: boolean;
  width?: number;
  testId?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, true, locked ? undefined : onClose);
  return createPortal(
    <div className="ui-overlay ui-overlay-center">
      <div className="ui-scrim" aria-hidden="true" onClick={locked ? undefined : onClose} />
      <div
        ref={ref}
        className="ui-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        style={{ width: `min(${width}px, 100%)` }}
        data-testid={testId}
        tabIndex={-1}
      >
        <div className="ui-dialog-head">
          {header}
          {locked ? null : (
            <button type="button" className="ui-drawer-close" aria-label="Close" onClick={onClose}>
              <Icon name="close" size={18} />
            </button>
          )}
        </div>
        <div className="ui-dialog-body">{children}</div>
        {footer ? <div className="ui-dialog-foot">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}
