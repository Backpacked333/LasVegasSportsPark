/**
 * Accessible button (SPK-UX-009): role, label, disabled and busy state are exposed to VoiceOver and
 * TalkBack; minimum 48 pt touch target; text scales with the OS setting.
 *
 * Variants of the visual system v2 (ADR-008, **Proposed**):
 * - `primary`: the accent fill, for the one main action of a view.
 * - `secondary`: the card surface with a line border.
 * - `tonal`: a soft accent tint, for a second action that still matters.
 * - `text`: no fill, the label in the accent colour, for a minor action.
 * - `destructive`: the danger fill, for removing or cancelling something.
 * - `onMedia`: over artwork, on the scrim token with a light label, which keeps 4.5:1 on any image.
 *
 * The variants of the first visual system stay until the redesign replaces their callers (Phase 6
 * removes them): `lime` (floodlight, the main action on a night card) and `ghost-dark` (a line
 * border on a night card).
 *
 * Sizes: `md` (48 pt, the usual capsule) and `lg` (56 pt, the primary action of a sticky bottom
 * bar), from `buttonHeight`. An optional decorative `icon` sits before the label. A capsule at its
 * usual height; with large text or a long label it grows into a rounded box and the label wraps
 * instead of truncating.
 *
 * Touch feedback (SPK-UX-010 restrained animation): a press darkens the fill at once; with motion
 * on, the button also springs in to the press scale (`PressableScale`), and with motion reduced
 * nothing moves. A press that lands plays a light impact through the injected haptics service, never
 * as the only feedback: the press always does something the screen shows. Colours follow the theme
 * (`useTheme`).
 */
import { ActivityIndicator, StyleSheet, Text, type TextStyle, type ViewStyle } from 'react-native';
import { Icon } from './Icon';
import { PressableScale, type PressHaptic } from './PressableScale';
import { buttonHeight, fonts, MIN_TOUCH_SIZE, spacing, type, useTheme, type Theme } from './theme';

export type ButtonVariant =
  | 'primary'
  | 'secondary'
  | 'tonal'
  | 'text'
  | 'destructive'
  | 'onMedia'
  /** First visual system; removed in Phase 6 of the redesign. Use `primary` on new screens. */
  | 'lime'
  /** First visual system; removed in Phase 6 of the redesign. Use `onMedia` or `secondary`. */
  | 'ghost-dark';

/** `md` 48 pt (the usual capsule); `lg` 56 pt (the action of a sticky bottom bar). */
export type ButtonSize = 'md' | 'lg';

export interface ButtonProps {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  size?: ButtonSize;
  disabled?: boolean;
  /** A command is in flight; the button is disabled and announced as busy (SPK-UX-008 processing). */
  busy?: boolean;
  /** What happens on press, when the label alone does not say it. */
  accessibilityHint?: string;
  /** Decorative Material Symbols name shown before the label (hidden from screen readers). */
  icon?: string;
  /** Stretch to the width of the parent (bottom action bars). */
  block?: boolean;
  /** The haptic a press plays (default a light impact; `none` for none). */
  haptic?: PressHaptic;
  testID?: string;
}

interface VariantLook {
  box: ViewStyle;
  /** The fill while pressed. */
  pressed: ViewStyle;
  text: string;
}

/** Fill, pressed fill and label colour of each variant in a theme. */
export function buttonLook({ colors }: Theme, variant: ButtonVariant): VariantLook {
  switch (variant) {
    case 'primary':
      return {
        box: { backgroundColor: colors.primary },
        pressed: { backgroundColor: colors.primaryPressed },
        text: colors.primaryText,
      };
    case 'secondary':
      return {
        box: { backgroundColor: colors.background, borderWidth: 1, borderColor: colors.control },
        pressed: { backgroundColor: colors.surface },
        text: colors.text,
      };
    case 'tonal':
      return {
        box: { backgroundColor: colors.tonal },
        pressed: { opacity: 0.86 },
        text: colors.onTonal,
      };
    case 'text':
      return {
        box: { backgroundColor: 'transparent' },
        pressed: { backgroundColor: colors.surface },
        text: colors.primary,
      };
    case 'destructive':
      return {
        box: { backgroundColor: colors.danger },
        pressed: { opacity: 0.86 },
        // `primaryText` is the label colour on danger fills too (theme.ts).
        text: colors.primaryText,
      };
    case 'onMedia':
      return {
        box: { backgroundColor: colors.scrimEnd, borderWidth: 1, borderColor: colors.onMediaMuted },
        pressed: { opacity: 0.86 },
        text: colors.onMedia,
      };
    case 'lime':
      return {
        box: { backgroundColor: colors.floodlight },
        pressed: { opacity: 0.86 },
        text: colors.onFloodlight,
      };
    case 'ghost-dark':
      return {
        box: { backgroundColor: 'transparent', borderWidth: 1, borderColor: colors.nightLine },
        pressed: { backgroundColor: colors.nightRaised },
        text: colors.onNight,
      };
  }
}

export function Button({
  label,
  onPress,
  variant = 'primary',
  size = 'md',
  disabled = false,
  busy = false,
  accessibilityHint,
  icon,
  block = false,
  haptic = 'light',
  testID,
}: ButtonProps) {
  const theme = useTheme();
  const inactive = disabled || busy;
  const look = buttonLook(theme, variant);
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: inactive, busy }}
      disabled={inactive}
      onPress={onPress}
      haptic={haptic}
      testID={testID}
      style={({ pressed }) => [
        styles.base,
        sizeStyles[size],
        variant === 'text' && styles.textVariant,
        look.box,
        block && styles.block,
        inactive && styles.inactive,
        pressed && look.pressed,
      ]}
    >
      {busy ? (
        <ActivityIndicator
          color={look.text}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        />
      ) : icon ? (
        <Icon name={icon} size={size === 'lg' ? 22 : 20} color={look.text} />
      ) : null}
      <Text style={[styles.label, labelStyles[size], { color: look.text }]}>{label}</Text>
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  base: {
    minWidth: MIN_TOUCH_SIZE,
    paddingHorizontal: 20,
    paddingVertical: spacing.sm,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
  },
  // A text button keeps its full target but hugs its label.
  textVariant: { paddingHorizontal: spacing.md },
  block: { alignSelf: 'stretch', flexGrow: 1 },
  inactive: { opacity: 0.5 },
  label: { ...type.body, ...fonts.extrabold, textAlign: 'center', flexShrink: 1 },
});

// Half the usual height: a capsule until the label wraps.
const sizeStyles = StyleSheet.create({
  md: { minHeight: buttonHeight.regular, borderRadius: buttonHeight.regular / 2 },
  lg: {
    minHeight: buttonHeight.sticky,
    borderRadius: buttonHeight.sticky / 2,
    paddingHorizontal: spacing.xl,
  },
});

const labelStyles = StyleSheet.create<Record<ButtonSize, TextStyle>>({
  md: {},
  lg: { fontSize: type.heading.fontSize, lineHeight: type.heading.lineHeight },
});
