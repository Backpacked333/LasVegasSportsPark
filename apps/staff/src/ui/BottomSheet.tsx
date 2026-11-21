/**
 * BottomSheet for phones (redesign handoff "Sheets"; S 1d: an issue's fix opens as a sheet).
 * Slides up 320 ms; closes by dragging the handle down, tapping the scrim, ✕ or Escape, except
 * while `locked` (a command is processing). Focus moves in and returns to the opener
 * (SPK-UX-009). Reduced motion: it fades instead of sliding.
 */
import { useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';
import { useFocusTrap } from './useFocusTrap';
import './primitives.css';

/** How far the sheet must be dragged down before letting go closes it. */
export const SHEET_DISMISS_PX = 96;

export function BottomSheet({
  open,
  onClose,
  title,
  titleId,
  children,
  footer,
  locked = false,
  testId,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  titleId: string;
  children: ReactNode;
  footer?: ReactNode;
  locked?: boolean;
  testId?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const start = useRef<number | null>(null);
  const [drag, setDrag] = useState(0);
  useFocusTrap(ref, open, locked ? undefined : onClose);
  if (!open) return null;

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (locked) return;
    start.current = event.clientY;
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (start.current === null) return;
    setDrag(Math.max(0, event.clientY - start.current));
  };
  const onPointerUp = () => {
    if (start.current === null) return;
    start.current = null;
    if (drag > SHEET_DISMISS_PX) onClose();
    setDrag(0);
  };

  return createPortal(
    <div className="ui-overlay ui-overlay-sheet">
      <div className="ui-scrim" aria-hidden="true" onClick={locked ? undefined : onClose} />
      <div
        ref={ref}
        className="ui-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        style={drag > 0 ? { transform: `translateY(${drag}px)` } : undefined}
        data-testid={testId}
      >
        <div
          className="ui-sheet-handle"
          aria-hidden="true"
          data-testid="sheet-handle"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          <span />
        </div>
        <div className="ui-sheet-head">
          <h3 id={titleId}>{title}</h3>
          <button
            type="button"
            className="ui-drawer-close"
            aria-label="Close"
            onClick={onClose}
            disabled={locked}
          >
            <Icon name="close" size={18} />
          </button>
        </div>
        <div className="ui-sheet-body">{children}</div>
        {footer ? <div className="ui-sheet-foot">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}
