/**
 * Accessible button (SPK-UX-009): role, label, disabled and busy state are exposed to VoiceOver and
 * TalkBack; minimum 48 pt touch target; text scales with the OS setting.
 *
 * Variants of the park system: `primary` (the accent, the one main action of a view), `secondary`
 * (the card surface with a line border), `lime` (floodlight, for the main action on a night card)
 * and `ghost-dark` (line border on a night card). An optional decorative `icon` sits before the
 * label. A capsule at its usual height; with large text or a long label it grows into a rounded
 * box and the label wraps instead of truncating.
 *
 * Touch feedback (SPK-UX-010 restrained animation): a press darkens the fill and draws the button
 * in slightly, at once and without an animation, so nothing moves for people who turned motion
 * off. Colours follow the theme (`useTheme`).
 */
import { ActivityIndicator, Pressable, StyleSheet, Text, type ViewStyle } from 'react-native';
import { Icon } from './Icon';
import { fonts, MIN_TOUCH_SIZE, spacing, type, useTheme, type Theme } from './theme';

export type ButtonVariant = 'primary' | 'secondary' | 'lime' | 'ghost-dark';

export interface ButtonProps {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  disabled?: boolean;
  /** A command is in flight; the button is disabled and announced as busy (SPK-UX-008 processing). */
  busy?: boolean;
  /** What happens on press, when the label alone does not say it. */
  accessibilityHint?: string;
  /** Decorative Material Symbols name shown before the label (hidden from screen readers). */
  icon?: string;
  /** Stretch to the width of the parent (bottom action bars). */
  block?: boolean;
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
  disabled = false,
  busy = false,
  accessibilityHint,
  icon,
  block = false,
  testID,
}: ButtonProps) {
  const theme = useTheme();
  const inactive = disabled || busy;
  const look = buttonLook(theme, variant);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: inactive, busy }}
      disabled={inactive}
      onPress={onPress}
      testID={testID}
      style={({ pressed }) => [
        styles.base,
        look.box,
        block && styles.block,
        inactive && styles.inactive,
        pressed && look.pressed,
        pressed && styles.pressed,
      ]}
    >
      {busy ? (
        <ActivityIndicator
          color={look.text}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        />
      ) : icon ? (
        <Icon name={icon} size={20} color={look.text} />
      ) : null}
      <Text style={[styles.label, { color: look.text }]}>{label}</Text>
    </Pressable>
  );
}

const BUTTON_HEIGHT = 48;

const styles = StyleSheet.create({
  base: {
    minHeight: BUTTON_HEIGHT,
    minWidth: MIN_TOUCH_SIZE,
    paddingHorizontal: 20,
    paddingVertical: spacing.sm,
    // Half the usual height: a capsule until the label wraps.
    borderRadius: BUTTON_HEIGHT / 2,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
  },
  block: { alignSelf: 'stretch', flexGrow: 1 },
  inactive: { opacity: 0.5 },
  pressed: { transform: [{ scale: 0.98 }] },
  label: { ...type.body, ...fonts.extrabold, textAlign: 'center', flexShrink: 1 },
});
