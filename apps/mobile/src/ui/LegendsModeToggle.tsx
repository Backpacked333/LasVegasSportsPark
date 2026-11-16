/**
 * The Legends mode switch: turns the whole app dark with a gold accent, at once, and keeps the
 * choice on this device between launches (`ThemeProvider`). It is a display preference of the
 * device, not of the account: offered signed in or out, and not sent to the API.
 *
 * Accessible (SPK-UX-009): one focusable row with the switch role, the name "Legends mode" and its
 * checked state; the state is also written in words ("On"/"Off"), never shown by colour alone; the
 * whole row is the touch target (56 pt), so the small switch does not have to be hit.
 */
import { Pressable, Switch, Text, View } from 'react-native';
import { Icon } from './Icon';
import {
  continuousCorners,
  fonts,
  makeStyles,
  radius,
  spacing,
  type,
  useLegendsMode,
  useTheme,
} from './theme';

export const LEGENDS_MODE_LABEL = 'Legends mode';

export function LegendsModeToggle({ testID = 'legends-mode-toggle' }: { testID?: string }) {
  const { legends, setLegends } = useLegendsMode();
  const { colors } = useTheme();
  const styles = useStyles();
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel={LEGENDS_MODE_LABEL}
      accessibilityHint="Switches the app between the classic look and a dark look with gold accents"
      accessibilityState={{ checked: legends }}
      onPress={() => setLegends(!legends)}
      android_ripple={{ color: colors.surface }}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
      testID={testID}
    >
      <View style={[styles.tile, legends && styles.tileOn]}>
        <Icon
          name="emoji_events"
          size={22}
          color={legends ? colors.onFloodlight : colors.textMuted}
        />
      </View>
      <View style={styles.text}>
        <Text style={styles.title}>{LEGENDS_MODE_LABEL}</Text>
        <Text style={styles.detail} testID={`${testID}-state`}>
          {legends
            ? 'On. Dark with gold accents.'
            : 'Off. Turn on for a dark look with gold accents.'}
        </Text>
      </View>
      {/* Drawn by the platform; the row above is the control, so this is not focusable or touchable. */}
      <View
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        <Switch
          value={legends}
          trackColor={{ false: colors.control, true: colors.primary }}
          ios_backgroundColor={colors.control}
        />
      </View>
    </Pressable>
  );
}

const useStyles = makeStyles(({ colors }) => ({
  row: {
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    marginHorizontal: spacing.lg,
    marginTop: spacing.sm,
    marginBottom: spacing.sm,
    paddingVertical: spacing.md,
    paddingHorizontal: 14,
    backgroundColor: colors.background,
    borderRadius: radius.lg,
    ...continuousCorners,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  pressed: { backgroundColor: colors.surface },
  tile: {
    width: 38,
    height: 38,
    borderRadius: radius.sm,
    ...continuousCorners,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
  },
  tileOn: { backgroundColor: colors.floodlight },
  text: { flex: 1, gap: spacing.xs },
  title: { ...type.body, ...fonts.bold, color: colors.text },
  detail: { ...type.caption, color: colors.textMuted },
}));
