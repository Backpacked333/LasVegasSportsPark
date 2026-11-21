/**
 * An on/off setting (ADR-008, **Proposed** visual system v2): a label, an optional description and
 * a switch. The whole row is the target and one element for screen readers (SPK-UX-009): role
 * `switch`, the label as its name, `checked` as its state, the description as its hint. The words
 * "On" or "Off" are shown next to the description, so the state never rests on the switch's colour
 * alone. A change plays the selection haptic; the switch and the words change with it.
 */
import { Pressable, Switch, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { useSelectionHaptic } from './ChoiceList';
import { fonts, makeStyles, MIN_TOUCH_SIZE, spacing, type, useTheme, type Theme } from './theme';

/** The switch's thumb: the light surface of the theme (white on classic, the light text on Legends). */
export function switchThumbColor(theme: Theme): string {
  return theme.dark ? theme.colors.text : theme.colors.background;
}

export interface SwitchRowProps {
  label: string;
  description?: string;
  value: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
  /** When the visible label needs its section for context ("Email for essential notices"). */
  accessibilityLabel?: string;
  onLabel?: string;
  offLabel?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function SwitchRow({
  label,
  description,
  value,
  onChange,
  disabled = false,
  accessibilityLabel,
  onLabel = 'On',
  offLabel = 'Off',
  style,
  testID,
}: SwitchRowProps) {
  const styles = useStyles();
  const theme = useTheme();
  const { colors } = theme;
  const haptic = useSelectionHaptic();
  const toggle = (next: boolean) => {
    if (disabled) return;
    haptic();
    onChange(next);
  };
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityHint={description}
      accessibilityState={{ checked: value, disabled }}
      disabled={disabled}
      onPress={() => toggle(!value)}
      style={({ pressed }) => [
        styles.row,
        pressed ? styles.pressed : null,
        disabled ? styles.disabled : null,
        style,
      ]}
      testID={testID}
    >
      <View style={styles.text}>
        <Text style={styles.label}>{label}</Text>
        <Text style={styles.description}>
          {value ? onLabel : offLabel}
          {description ? `. ${description}` : ''}
        </Text>
      </View>
      {/* The row is the control; the switch only shows its state (and still takes a direct tap). */}
      <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        <Switch
          value={value}
          onValueChange={toggle}
          disabled={disabled}
          trackColor={{ false: colors.control, true: colors.primary }}
          // A light thumb in both themes (the platform's own default is teal on the web and
          // Android, which clashed with the accent track in Legends mode).
          thumbColor={switchThumbColor(theme)}
          ios_backgroundColor={colors.control}
        />
      </View>
    </Pressable>
  );
}

const useStyles = makeStyles(({ colors }) => ({
  row: {
    minHeight: MIN_TOUCH_SIZE,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.sm,
  },
  pressed: { opacity: 0.8 },
  disabled: { opacity: 0.55 },
  text: { flex: 1, gap: spacing.xxs },
  label: { ...type.body, ...fonts.semibold, color: colors.text },
  description: { ...type.footnote, color: colors.textMuted },
}));
