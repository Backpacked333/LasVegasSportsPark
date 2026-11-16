/**
 * Toasts (ADR-008 visual system v2, **Proposed**): a short line at the bottom of the screen that
 * confirms a low-stakes success ("Saved to your calendar", "Link copied") and goes away by itself.
 *
 * Toasts are for low-stakes successes and notes only. They never replace the persistent outcome
 * screens: a registration, a payment, a refusal or an outcome not yet known (SPK-UX-008, §4.9)
 * keeps its own screen or state view, which stays until the person moves on. Nothing a person must
 * act on, or must be able to read again, goes in a toast.
 *
 * - `useToast().show({ message, tone })` shows one toast; a newer one replaces the one on screen.
 *   `tone` is `success` (the default) or `info`, each with its own decorative glyph, so the tone is
 *   never carried by colour alone (SPK-UX-009).
 * - The words are announced: the toast is a polite live region on Android and is posted to
 *   VoiceOver on iOS (`LiveRegion`, src/ui/announce.tsx).
 * - It dismisses itself after `TOAST_DURATION_MS` (or the provider's `durationMs`) on a timer, which
 *   tests drive with Jest's fake timers. The app's injected clock (`services.now`) reads the time
 *   but schedules nothing, so the timer is the one source of the delay.
 * - With motion on it fades and rises in and fades out (`motionTokens` through `useMotion()`);
 *   with motion reduced it appears and disappears at once.
 * - Without a `ToastProvider` above it (screen tests), `show` does nothing, so no screen needs one.
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
import { StyleSheet, View } from 'react-native';
import Animated, { FadeInDown, FadeOut } from 'react-native-reanimated';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';
import { LiveRegion } from './announce';
import { Icon } from './Icon';
import { useMotion } from './motion';
import { Text } from './Text';
import { elevation, layout, makeStyles, radius, spacing } from './theme';

export type ToastTone = 'success' | 'info';

export interface ToastOptions {
  message: string;
  tone?: ToastTone;
}

export interface ToastApi {
  show(options: ToastOptions): void;
  /** Hides the toast on screen, if any. */
  dismiss(): void;
}

/** How long a toast stays, in milliseconds. */
export const TOAST_DURATION_MS = 4_000;

/** Above the tab bar: what a toast keeps clear of the bottom safe area. */
const TOAST_BOTTOM_OFFSET = 72;

const TOAST_GLYPHS: Readonly<Record<ToastTone, string>> = {
  success: 'check_circle',
  info: 'info',
};

const NO_TOASTS: ToastApi = { show: () => undefined, dismiss: () => undefined };

const ToastContext = createContext<ToastApi>(NO_TOASTS);

/** Shows toasts; a no-op without a `ToastProvider` above. */
export function useToast(): ToastApi {
  return useContext(ToastContext);
}

interface ShownToast {
  id: number;
  message: string;
  tone: ToastTone;
}

export function ToastProvider({
  children,
  durationMs = TOAST_DURATION_MS,
}: {
  children: ReactNode;
  durationMs?: number;
}) {
  const [toast, setToast] = useState<ShownToast | null>(null);
  const next = useRef(1);

  const dismiss = useCallback(() => setToast(null), []);
  const show = useCallback(({ message, tone = 'success' }: ToastOptions) => {
    if (message.trim() === '') return;
    const id = next.current;
    next.current += 1;
    setToast({ id, message, tone });
  }, []);

  // One timer per toast shown: a newer toast restarts it, an unmount clears it.
  useEffect(() => {
    if (!toast) return undefined;
    const timer = setTimeout(() => {
      setToast((current) => (current?.id === toast.id ? null : current));
    }, durationMs);
    return () => clearTimeout(timer);
  }, [toast, durationMs]);

  const api = useMemo<ToastApi>(() => ({ show, dismiss }), [show, dismiss]);
  return (
    <ToastContext.Provider value={api}>
      <View style={styles.root}>
        {children}
        <View style={styles.layer} pointerEvents="box-none">
          {toast ? <ToastView key={toast.id} toast={toast} /> : null}
        </View>
      </View>
    </ToastContext.Provider>
  );
}

const useStyles = makeStyles((theme) => ({
  toast: {
    ...elevation(theme, 'raised'),
    backgroundColor: theme.colors.toast,
  },
  icon: { color: theme.colors.onToast },
  message: { color: theme.colors.onToast },
}));

function ToastView({ toast }: { toast: ShownToast }) {
  const motion = useMotion();
  const themed = useStyles();
  // Absent outside a SafeAreaProvider (a test rendering the provider alone).
  const insets = useContext(SafeAreaInsetsContext);
  const entering = motion.reduced ? undefined : FadeInDown.duration(motion.duration('base'));
  const exiting = motion.reduced ? undefined : FadeOut.duration(motion.duration('fast'));
  return (
    <Animated.View
      entering={entering}
      exiting={exiting}
      style={[styles.position, { bottom: (insets?.bottom ?? 0) + TOAST_BOTTOM_OFFSET }]}
      pointerEvents="none"
    >
      <LiveRegion
        announcement={toast.message}
        occurrence={toast.id}
        style={[styles.toast, themed.toast]}
        testID="toast"
      >
        <Icon name={TOAST_GLYPHS[toast.tone]} size={20} color={themed.icon.color} />
        <Text variant="callout" style={[styles.message, themed.message]}>
          {toast.message}
        </Text>
      </LiveRegion>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  layer: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 },
  position: { position: 'absolute', left: layout.gutter, right: layout.gutter },
  toast: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: 48,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radius.lg,
  },
  message: { flexShrink: 1 },
});
