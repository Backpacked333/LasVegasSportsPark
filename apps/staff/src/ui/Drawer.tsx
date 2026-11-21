/**
 * Drawer (redesign handoff S 3a): slides in from the right over a dimmed page. Escape, ✕ or the
 * scrim close it (unless `locked` while something is processing); focus moves into it, stays there
 * and returns to the control that opened it (SPK-UX-009). Reduced motion: no slide.
 *
 * `header` is the drawer's own top (the dark session header in S 3a) and must contain the element
 * named by `labelledBy`; `footer` is the fixed action row.
 */
import { useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';
import { useFocusTrap } from './useFocusTrap';
import './primitives.css';

export function Drawer({
  open,
  onClose,
  labelledBy,
  header,
  footer,
  children,
  width = 480,
  locked = false,
  tone = 'light',
  testId,
}: {
  open: boolean;
  onClose: () => void;
  labelledBy: string;
  header: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  width?: number;
  /** While a command is processing the drawer cannot be dismissed. */
  locked?: boolean;
  /** `night`: the header sits on the dark night surface (S 3a). */
  tone?: 'light' | 'night';
  testId?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, open, locked ? undefined : onClose);
  if (!open) return null;
  return createPortal(
    <div className="ui-overlay" data-testid={testId ? `${testId}-overlay` : undefined}>
      <div
        className="ui-scrim"
        aria-hidden="true"
        onClick={locked ? undefined : onClose}
        data-testid="drawer-scrim"
      />
      <div
        ref={ref}
        className="ui-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        style={{ width: `min(${width}px, 100vw)` }}
        data-testid={testId}
      >
        <div className="ui-drawer-head" data-tone={tone}>
          {header}
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
        <div className="ui-drawer-body">{children}</div>
        {footer ? <div className="ui-drawer-foot">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}
