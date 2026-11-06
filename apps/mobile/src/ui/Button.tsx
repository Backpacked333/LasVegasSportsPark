/**
 * Accessible button (SPK-UX-009): role, label, disabled and busy state are exposed to VoiceOver and
 * TalkBack; minimum 44 pt touch target; text scales with the OS setting.
 *
 * Variants of the park system: `primary` (pitch green, the one main action of a view), `secondary`
 * (white with a line border), `lime` (floodlight, for the main action on a night card) and
 * `ghost-dark` (line border on a night card). An optional decorative `icon` sits before the label.
 */
import { ActivityIndicator, Pressable, StyleSheet, Text } from 'react-native';
import { Icon } from './Icon';
import { colors, fonts, MIN_TOUCH_SIZE, radius, spacing, type } from './theme';

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

const VARIANT_STYLES = {
  primary: { box: { backgroundColor: colors.primary }, text: colors.primaryText },
  secondary: {
    box: { backgroundColor: colors.background, borderWidth: 1, borderColor: colors.control },
    text: colors.text,
  },
  lime: { box: { backgroundColor: colors.floodlight }, text: colors.night },
  'ghost-dark': {
    box: { backgroundColor: 'transparent', borderWidth: 1, borderColor: colors.nightLine },
    text: colors.primaryText,
  },
} as const;

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
  const inactive = disabled || busy;
  const look = VARIANT_STYLES[variant];
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

const styles = StyleSheet.create({
  base: {
    minHeight: 48,
    minWidth: MIN_TOUCH_SIZE,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
  },
  block: { alignSelf: 'stretch', flexGrow: 1 },
  inactive: { opacity: 0.5 },
  pressed: { opacity: 0.82 },
  label: { ...type.body, ...fonts.extrabold, textAlign: 'center', flexShrink: 1 },
});
