/**
 * Toasts (ADR-008 visual system v2, **Proposed**; redesign handoff "Toasts" and Phase 0 "Toast
 * with Undo"): a short line at the bottom of the screen, above the tab bar, that confirms a
 * low-stakes result ("Saved: Maya is going.") and goes away by itself.
 *
 * Toasts are for low-stakes results and notes only. They never replace the persistent outcome
 * screens: a registration, a payment, a refusal or an outcome not yet known (SPK-UX-008, §4.9)
 * keeps its own screen or state view, which stays until the person moves on. Nothing a person must
 * act on, or must be able to read again, goes in a toast alone.
 *
 * - `useToast().show({ message, tone, action })` shows one toast; a newer one replaces the one on
 *   screen (one at a time). `tone` is `success` (the default), `info` or `danger` (a write that did
 *   not save), each with its own decorative glyph, so the tone is never carried by colour alone
 *   (SPK-UX-009).
 * - `action` adds one button ("Undo", "Try again"). A toast with an action stays
 *   `TOAST_ACTION_DURATION_MS` (5 s), a plain one `TOAST_DURATION_MS` (2.4 s); the provider's
 *   `durationMs` overrides the plain duration. Pressing the action runs it and hides the toast.
 * - The words are announced: the toast is a polite live region on Android and is posted to
 *   VoiceOver on iOS (`LiveRegion`, src/ui/announce.tsx), with the action's label at the end.
 * - It dismisses itself on a timer, which tests drive with Jest's fake timers. The app's injected
 *   clock (`services.now`) reads the time but schedules nothing, so the timer is the one source of
 *   the delay.
 * - With motion on it fades and rises in (220 ms) and fades out; with motion reduced it appears and
 *   disappears at once.
 * - Without a `ToastProvider` above it, `show` does nothing.
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
import { Pressable, StyleSheet, View } from 'react-native';
import Animated, { FadeInDown, FadeOut } from 'react-native-reanimated';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';
import { LiveRegion, sentences } from './announce';
import { Icon } from './Icon';
import { useMotion } from './motion';
import { Text } from './Text';
import { elevation, fonts, layout, makeStyles, MIN_TOUCH_SIZE, radius, spacing } from './theme';

export type ToastTone = 'success' | 'info' | 'danger';

export interface ToastAction {
  /** "Undo", "Try again". */
  label: string;
  onPress: () => void;
}

export interface ToastOptions {
  message: string;
  tone?: ToastTone;
  /** One button on the toast; the toast then stays 5 s. */
  action?: ToastAction;
}

export interface ToastApi {
  show(options: ToastOptions): void;
  /** Hides the toast on screen, if any. */
  dismiss(): void;
}

/** How long a plain toast stays, in milliseconds (handoff: 2.4 s). */
export const TOAST_DURATION_MS = 2_400;
/** How long a toast with an action (Undo, Try again) stays (handoff: 5 s). */
export const TOAST_ACTION_DURATION_MS = 5_000;

/** Above the tab bar: what a toast keeps clear of the bottom safe area. */
const TOAST_BOTTOM_OFFSET = 72;

const TOAST_GLYPHS: Readonly<Record<ToastTone, string>> = {
  success: 'check_circle',
  info: 'info',
  danger: 'error',
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
  action: ToastAction | null;
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
  const show = useCallback(({ message, tone = 'success', action }: ToastOptions) => {
    if (message.trim() === '') return;
    const id = next.current;
    next.current += 1;
    setToast({ id, message, tone, action: action ?? null });
  }, []);

  // One timer per toast shown: a newer toast restarts it, an unmount clears it.
  useEffect(() => {
    if (!toast) return undefined;
    const timer = setTimeout(
      () => {
        setToast((current) => (current?.id === toast.id ? null : current));
      },
      toast.action ? TOAST_ACTION_DURATION_MS : durationMs,
    );
    return () => clearTimeout(timer);
  }, [toast, durationMs]);

  const api = useMemo<ToastApi>(() => ({ show, dismiss }), [show, dismiss]);
  return (
    <ToastContext.Provider value={api}>
      <View style={styles.root}>
        {children}
        <View style={styles.layer} pointerEvents="box-none">
          {toast ? (
            <ToastView
              key={toast.id}
              toast={toast}
              onAction={() => {
                setToast((current) => (current?.id === toast.id ? null : current));
                toast.action?.onPress();
              }}
            />
          ) : null}
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
  danger: { color: theme.colors.countBadge },
  message: { color: theme.colors.onToast },
  action: { ...fonts.bold, color: theme.colors.floodlight },
}));

function ToastView({ toast, onAction }: { toast: ShownToast; onAction: () => void }) {
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
      pointerEvents={toast.action ? 'box-none' : 'none'}
    >
      <LiveRegion
        announcement={toast.action ? sentences(toast.message, toast.action.label) : toast.message}
        occurrence={toast.id}
        style={[styles.toast, themed.toast]}
        testID="toast"
      >
        <View style={styles.words}>
          <Icon
            name={TOAST_GLYPHS[toast.tone]}
            size={20}
            color={toast.tone === 'danger' ? themed.danger.color : themed.icon.color}
          />
          <Text variant="callout" style={[styles.message, themed.message]}>
            {toast.message}
          </Text>
        </View>
        {toast.action ? (
          <Pressable
            onPress={onAction}
            accessibilityRole="button"
            accessibilityLabel={toast.action.label}
            style={({ pressed }) => [styles.action, pressed ? styles.pressed : null]}
            testID="toast-action"
          >
            <Text variant="callout" style={themed.action}>
              {toast.action.label}
            </Text>
          </Pressable>
        ) : null}
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
    paddingLeft: spacing.lg,
    paddingRight: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: radius.lg,
  },
  words: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
  },
  message: { flexShrink: 1 },
  action: {
    minHeight: MIN_TOUCH_SIZE,
    minWidth: MIN_TOUCH_SIZE,
    paddingHorizontal: spacing.md,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.pill,
  },
  pressed: { opacity: 0.7 },
});
