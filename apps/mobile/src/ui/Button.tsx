/**
 * Accessible button (SPK-UX-009): role, label, disabled and busy state are exposed to VoiceOver and
 * TalkBack; minimum 44 pt touch target; text scales with the OS setting.
 */
import { ActivityIndicator, Pressable, StyleSheet, Text } from 'react-native';
import { colors, MIN_TOUCH_SIZE, spacing, type } from './theme';

export interface ButtonProps {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary';
  disabled?: boolean;
  /** A command is in flight; the button is disabled and announced as busy (SPK-UX-008 processing). */
  busy?: boolean;
  /** What happens on press, when the label alone does not say it. */
  accessibilityHint?: string;
  testID?: string;
}

export function Button({
  label,
  onPress,
  variant = 'primary',
  disabled = false,
  busy = false,
  accessibilityHint,
  testID,
}: ButtonProps) {
  const inactive = disabled || busy;
  const primary = variant === 'primary';
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
        primary ? styles.primary : styles.secondary,
        inactive && styles.inactive,
        pressed && styles.pressed,
      ]}
    >
      {busy ? (
        <ActivityIndicator
          color={primary ? colors.primaryText : colors.primary}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        />
      ) : null}
      <Text style={[styles.label, primary ? styles.primaryLabel : styles.secondaryLabel]}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    minHeight: MIN_TOUCH_SIZE,
    minWidth: MIN_TOUCH_SIZE,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
  },
  primary: { backgroundColor: colors.primary },
  secondary: { backgroundColor: colors.background, borderWidth: 1.5, borderColor: colors.primary },
  inactive: { opacity: 0.55 },
  pressed: { opacity: 0.8 },
  label: { ...type.body, fontWeight: '600', textAlign: 'center' },
  primaryLabel: { color: colors.primaryText },
  secondaryLabel: { color: colors.primary },
});
