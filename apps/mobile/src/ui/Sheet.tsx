/**
 * Sheet: the one bottom sheet of the customer app, for in-screen choices (filters, pickers, short
 * confirmations). ADR-008 (**Proposed** visual system v2); screens never import the sheet library
 * themselves.
 *
 * Route-level sheets (the pass, a notice, filters that are a screen of their own) are not this
 * component: they are routes presented with the native stack's `formSheet`.
 *
 * Two presentations (`sheetPresentationFor`):
 * - `native`: `@gorhom/bottom-sheet`'s `BottomSheetModal`, with drag, snapping and keyboard
 *   handling, on iOS and Android under the `BottomSheetModalProvider` of the root layout.
 * - `modal`: React Native's `Modal` with the same header, content and footer. Used on the web, in
 *   Jest (so tests query the content like any other), and wherever no `BottomSheetModalProvider`
 *   is above: no provider means the inert path, the same rule as `GlassProvider`
 *   (src/ui/GlassSurface.tsx). `SheetPresentationProvider` fixes it for previews and tests.
 *
 * Both have a backdrop in the `backdrop` token that closes the sheet, a header with the title and a
 * labelled close button, and close on the Android back button and the VoiceOver escape gesture.
 * Focus (SPK-UX-009): on open, focus and the screen reader's focus move to the title; on close
 * they go back to `returnFocusTo` (the control that opened it) where one is given. Motion follows
 * `useMotion()`: with reduced motion (and without a `MotionProvider`) the sheet appears in place.
 *
 * Not verified on devices here (§6.2): the native presentation renders only through the library's
 * Jest mock.
 */
import {
  BottomSheetBackdrop,
  BottomSheetModal,
  BottomSheetScrollView,
  useBottomSheetModalInternal,
  useBottomSheetSpringConfigs,
  useBottomSheetTimingConfigs,
  type BottomSheetBackdropProps,
} from '@gorhom/bottom-sheet';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  type ReactNode,
  type RefObject,
} from 'react';
import {
  AccessibilityInfo,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Icon } from './Icon';
import { useMotion } from './motion';
import {
  continuousCorners,
  elevation,
  layout,
  makeStyles,
  MIN_TOUCH_SIZE,
  motionTokens,
  radius,
  spacing,
  type,
  useTheme,
} from './theme';

export type SheetPresentation = 'native' | 'modal';

/** Which presentation a runtime gets. Pure, so the rule is tested without a device. */
export function sheetPresentationFor(runtime: {
  os: string;
  /** A `BottomSheetModalProvider` is above the sheet. */
  provider: boolean;
  /** Running under Jest (the library is its mock there). */
  test: boolean;
}): SheetPresentation {
  if (runtime.test || !runtime.provider) return 'modal';
  return runtime.os === 'ios' || runtime.os === 'android' ? 'native' : 'modal';
}

const PresentationOverride = createContext<SheetPresentation | null>(null);

/** Fixes the presentation of the sheets below (previews and tests). */
export function SheetPresentationProvider({
  presentation,
  children,
}: {
  presentation: SheetPresentation;
  children: ReactNode;
}) {
  return (
    <PresentationOverride.Provider value={presentation}>{children}</PresentationOverride.Provider>
  );
}

const UNDER_TEST = process.env.NODE_ENV === 'test';

function useSheetPresentation(): SheetPresentation {
  const override = useContext(PresentationOverride);
  // `true` asks for null instead of a throw when no provider is above.
  const provider = useBottomSheetModalInternal(true) !== null;
  return override ?? sheetPresentationFor({ os: Platform.OS, provider, test: UNDER_TEST });
}

type FocusTarget = Parameters<typeof AccessibilityInfo.sendAccessibilityEvent>[0];

/**
 * Moves the screen reader's focus (and, on the web, the keyboard focus) to `node`. Skipped when
 * the node is gone.
 */
export function moveFocusTo(node: unknown): void {
  if (!node) return;
  if (Platform.OS === 'web') {
    (node as { focus?: () => void }).focus?.();
    return;
  }
  AccessibilityInfo.sendAccessibilityEvent(node as FocusTarget, 'focus');
}

export interface SheetProps {
  open: boolean;
  /** The person closed it: the backdrop, the close button, back, escape, or a drag down. */
  onClose: () => void;
  /** The sheet's title: a header, and where focus goes on open. */
  title: string;
  children: ReactNode;
  /** Actions pinned under the content ("Apply", "Done"). */
  footer?: ReactNode;
  /** The control that opened the sheet: focus goes back to it on close. */
  returnFocusTo?: RefObject<unknown>;
  closeLabel?: string;
  testID?: string;
}

export function Sheet(props: SheetProps) {
  const presentation = useSheetPresentation();
  useSheetFocus(props.open, props.returnFocusTo);
  return presentation === 'native' ? <NativeSheet {...props} /> : <ModalSheet {...props} />;
}

/** Focus back to the trigger on close (SPK-UX-009); the header moves it to the title on open. */
function useSheetFocus(open: boolean, returnFocusTo: RefObject<unknown> | undefined) {
  const wasOpen = useRef(open);
  useEffect(() => {
    if (wasOpen.current === open) return undefined;
    wasOpen.current = open;
    if (open) return undefined;
    // After the sheet has gone, so the trigger is reachable again.
    const id = setTimeout(() => moveFocusTo(returnFocusTo?.current), 0);
    return () => clearTimeout(id);
  }, [open, returnFocusTo]);
}

function SheetHeader({
  title,
  onClose,
  closeLabel,
  open,
}: {
  title: string;
  onClose: () => void;
  closeLabel: string;
  open: boolean;
}) {
  const styles = useStyles();
  const { colors } = useTheme();
  const motion = useMotion();
  const titleRef = useRef<Text>(null);
  const delay = motion.duration('base');
  useEffect(() => {
    if (!open) return undefined;
    // Once the sheet is in place (at once while motion is reduced).
    const id = setTimeout(() => moveFocusTo(titleRef.current), delay);
    return () => clearTimeout(id);
  }, [open, delay]);
  return (
    <View style={styles.header}>
      <Text
        ref={titleRef}
        style={styles.title}
        accessibilityRole="header"
        {...(Platform.OS === 'web' ? { tabIndex: -1 as const } : {})}
      >
        {title}
      </Text>
      <Pressable
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel={closeLabel}
        style={({ pressed }) => [styles.close, pressed ? styles.pressed : null]}
      >
        <Icon name="close" size={22} color={colors.onSheet} />
      </Pressable>
    </View>
  );
}

function ModalSheet({
  open,
  onClose,
  title,
  children,
  footer,
  closeLabel = 'Close',
  testID,
}: SheetProps) {
  const styles = useStyles();
  const theme = useTheme();
  const motion = useMotion();
  return (
    <Modal
      visible={open}
      transparent
      animationType={motion.reduced ? 'none' : 'fade'}
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <View style={styles.root}>
        <Pressable
          style={[StyleSheet.absoluteFill, styles.backdrop]}
          onPress={onClose}
          accessible={false}
          importantForAccessibility="no"
          testID="sheet-backdrop"
        />
        <View
          style={[elevation(theme, 'sheet'), styles.panel]}
          accessibilityViewIsModal
          onAccessibilityEscape={onClose}
          testID={testID ?? 'sheet'}
        >
          <View style={styles.grabber} />
          <SheetHeader title={title} onClose={onClose} closeLabel={closeLabel} open={open} />
          <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent}>
            {children}
          </ScrollView>
          {footer ? <View style={styles.footer}>{footer}</View> : null}
        </View>
      </View>
    </Modal>
  );
}

function NativeSheet({
  open,
  onClose,
  title,
  children,
  footer,
  closeLabel = 'Close',
  testID,
}: SheetProps) {
  const styles = useStyles();
  const { colors } = useTheme();
  const motion = useMotion();
  const ref = useRef<BottomSheetModal>(null);
  const openRef = useRef(open);
  openRef.current = open;
  const spring = useBottomSheetSpringConfigs({ ...motionTokens.springs.sheet });
  const instant = useBottomSheetTimingConfigs({ duration: 0 });

  useEffect(() => {
    if (open) ref.current?.present();
    else ref.current?.dismiss();
  }, [open]);

  const renderBackdrop = useCallback(
    (backdrop: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop
        {...backdrop}
        appearsOnIndex={0}
        disappearsOnIndex={-1}
        opacity={1}
        pressBehavior="close"
        style={[backdrop.style, { backgroundColor: colors.backdrop }]}
      />
    ),
    [colors.backdrop],
  );

  return (
    <BottomSheetModal
      ref={ref}
      // Dismissed by the person (a drag, the backdrop): tell the screen. A dismiss the screen asked
      // for (open went false) is not reported back.
      onDismiss={() => {
        if (openRef.current) onClose();
      }}
      backdropComponent={renderBackdrop}
      backgroundStyle={styles.nativeBackground}
      handleIndicatorStyle={{ backgroundColor: colors.control }}
      animationConfigs={motion.reduced ? instant : spring}
      accessibilityViewIsModal
    >
      <BottomSheetScrollView
        contentContainerStyle={styles.nativeContent}
        onAccessibilityEscape={onClose}
        testID={testID ?? 'sheet'}
      >
        <SheetHeader title={title} onClose={onClose} closeLabel={closeLabel} open={open} />
        <View style={styles.bodyContent}>{children}</View>
        {footer ? <View style={styles.footer}>{footer}</View> : null}
      </BottomSheetScrollView>
    </BottomSheetModal>
  );
}

const useStyles = makeStyles(({ colors }) => ({
  root: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { backgroundColor: colors.backdrop },
  panel: {
    maxHeight: '90%',
    borderTopLeftRadius: radius.sheet,
    borderTopRightRadius: radius.sheet,
    ...continuousCorners,
    paddingBottom: spacing.xl,
  },
  grabber: {
    alignSelf: 'center',
    width: 36,
    height: 5,
    marginTop: spacing.sm,
    borderRadius: radius.pill,
    backgroundColor: colors.control,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingLeft: layout.gutter,
    paddingRight: spacing.sm,
    paddingTop: spacing.sm,
  },
  title: { ...type.title3, color: colors.onSheet, flex: 1 },
  close: {
    minWidth: MIN_TOUCH_SIZE,
    minHeight: MIN_TOUCH_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.pill,
  },
  pressed: { opacity: 0.7 },
  body: { flexGrow: 0 },
  bodyContent: { paddingHorizontal: layout.gutter, paddingTop: spacing.md, gap: spacing.md },
  footer: { paddingHorizontal: layout.gutter, paddingTop: spacing.lg, gap: spacing.sm },
  nativeBackground: {
    backgroundColor: colors.sheet,
    borderTopLeftRadius: radius.sheet,
    borderTopRightRadius: radius.sheet,
  },
  nativeContent: { paddingBottom: spacing.xxl },
}));
