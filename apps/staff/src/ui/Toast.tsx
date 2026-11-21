/**
 * Toast with Undo (redesign handoff, INTERACTIONS "Global behaviours" → Toasts): bottom of the
 * screen, above the phone tab bar; 2.4 s, or 5 s when it carries Undo (or the duration given);
 * one at a time: a new toast replaces the old one, whose `onClose('replaced')` runs so nothing
 * waiting on it is lost. A countdown (`countdown: true`) writes the time left in the Undo label,
 * e.g. "Undo (2:00)". Announced politely (`role="status"`); errors assertively.
 *
 * The toast only presents: a write that can be undone keeps its own state (optimistic UI, or a
 * delayed send like the weather cancellation) and is told through `onUndo` and `onClose`.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useApp } from '../providers/AppProviders';
import { Icon } from './Icon';
import { STATUS_GLYPHS } from './StatusBadge';
import './primitives.css';

export const TOAST_MS = 2_400;
export const TOAST_UNDO_MS = 5_000;

export type ToastTone = 'neutral' | 'success' | 'error' | 'warning' | 'info';
export type ToastCloseReason = 'timeout' | 'undo' | 'dismissed' | 'replaced' | 'action';

export interface ToastInput {
  message: ReactNode;
  tone?: ToastTone;
  /** Undo for the write the toast reports. */
  onUndo?: () => void;
  /** A second action (e.g. "Try again", "Notify"). */
  action?: {
    label: string;
    onClick: () => void;
    /** Drawn as a floodlight pill (S 3e Notify). */ primary?: boolean;
  };
  durationMs?: number;
  /** Write the time left in the Undo label ("Undo (1:59)"). */
  countdown?: boolean;
  /**
   * Stays until its action or Undo is chosen (S 3e: a moved booking waits for Notify or Undo): no
   * timer and no dismiss button. A newer toast still replaces it (`onClose('replaced')`).
   */
  persistent?: boolean;
  onClose?: (reason: ToastCloseReason) => void;
}

interface ShownToast extends ToastInput {
  id: number;
  endsAt: number;
}

interface ToastApi {
  show(toast: ToastInput): number;
  dismiss(id?: number): void;
}

const NOOP: ToastApi = { show: () => 0, dismiss: () => undefined };
const ToastContext = createContext<ToastApi>(NOOP);

/** The toast API of the dashboard; outside the provider (an isolated test) it does nothing. */
export function useToast(): ToastApi {
  return useContext(ToastContext);
}

function clock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const { services } = useApp();
  const [toast, setToast] = useState<ShownToast | null>(null);
  const current = useRef<ShownToast | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const nextId = useRef(1);

  const close = useCallback((reason: ToastCloseReason, id?: number) => {
    const shown = current.current;
    if (!shown || (id !== undefined && shown.id !== id)) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    current.current = null;
    setToast(null);
    shown.onClose?.(reason);
  }, []);

  const show = useCallback(
    (input: ToastInput) => {
      close('replaced');
      const duration = input.durationMs ?? (input.onUndo ? TOAST_UNDO_MS : TOAST_MS);
      const shown: ShownToast = {
        ...input,
        id: nextId.current++,
        endsAt: services.now().getTime() + duration,
      };
      current.current = shown;
      setToast(shown);
      if (!input.persistent) timer.current = setTimeout(() => close('timeout', shown.id), duration);
      return shown.id;
    },
    [close, services],
  );

  const api = useMemo<ToastApi>(
    () => ({ show, dismiss: (id) => close('dismissed', id) }),
    [show, close],
  );

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="ui-toast-region" aria-live="polite" data-testid="toast-region">
        {toast ? (
          <ToastView
            key={toast.id}
            toast={toast}
            now={() => services.now().getTime()}
            onUndo={() => {
              toast.onUndo?.();
              close('undo', toast.id);
            }}
            onAction={() => {
              toast.action?.onClick();
              close('action', toast.id);
            }}
            onDismiss={() => close('dismissed', toast.id)}
          />
        ) : null}
      </div>
    </ToastContext.Provider>
  );
}

function ToastView({
  toast,
  now,
  onUndo,
  onAction,
  onDismiss,
}: {
  toast: ShownToast;
  now: () => number;
  onUndo: () => void;
  onAction: () => void;
  onDismiss: () => void;
}) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!toast.countdown) return;
    const id = setInterval(() => tick((t) => t + 1), 1_000);
    return () => clearInterval(id);
  }, [toast.countdown]);
  const tone = toast.tone ?? 'neutral';
  const glyph =
    tone === 'success'
      ? STATUS_GLYPHS.success
      : tone === 'error'
        ? STATUS_GLYPHS.danger
        : tone === 'warning'
          ? STATUS_GLYPHS.warning
          : tone === 'info'
            ? STATUS_GLYPHS.info
            : null;
  return (
    <div
      className="ui-toast"
      data-tone={tone}
      role={tone === 'error' ? 'alert' : 'status'}
      data-testid="toast"
    >
      {glyph ? (
        <span className="ui-toast-glyph" aria-hidden="true">
          {glyph}
        </span>
      ) : null}
      <span className="ui-toast-message">{toast.message}</span>
      {toast.action ? (
        <button
          type="button"
          className="ui-toast-button"
          data-primary={toast.action.primary || undefined}
          onClick={onAction}
        >
          {toast.action.label}
        </button>
      ) : null}
      {toast.onUndo ? (
        <button type="button" className="ui-toast-button" onClick={onUndo}>
          {toast.countdown ? `Undo (${clock(toast.endsAt - now())})` : 'Undo'}
        </button>
      ) : null}
      {toast.persistent ? null : (
        <button
          type="button"
          className="ui-toast-close"
          aria-label="Dismiss message"
          onClick={onDismiss}
        >
          <Icon name="close" size={16} />
        </button>
      )}
    </div>
  );
}
