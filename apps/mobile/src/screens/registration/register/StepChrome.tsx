/**
 * The chrome of the registration steps (redesign handoff 1e, 2a, 1f): three thin segments (Who,
 * Options, Review), and for Options and Review a top bar with the back arrow and the step's title.
 * Screen readers hear "Step 2 of 3, Options" once; the segments are decorative.
 */
import { View } from 'react-native';
import { useInsets } from '../../../ui/insets';
import { IconButton } from '../../../ui/IconButton';
import { Text } from '../../../ui/Text';
import { fonts, layout, makeStyles, radius, spacing } from '../../../ui/theme';

export const STEPS = ['Who', 'Options', 'Review'] as const;
export type StepName = (typeof STEPS)[number];

export function StepBar({ step, style }: { step: StepName; style?: object }) {
  const styles = useStyles();
  const index = STEPS.indexOf(step);
  return (
    <View
      style={[styles.bar, style]}
      accessible
      accessibilityLabel={`Step ${index + 1} of ${STEPS.length}, ${step}`}
      testID="register-steps"
    >
      {STEPS.map((name, i) => (
        <View key={name} style={[styles.segment, i <= index ? styles.on : styles.off]} />
      ))}
    </View>
  );
}

export function StepHeader({
  title,
  step,
  onBack,
}: {
  title: string;
  step: StepName;
  onBack: () => void;
}) {
  const styles = useStyles();
  const insets = useInsets();
  return (
    <View style={[styles.header, { paddingTop: insets.top + spacing.xs }]}>
      <View style={styles.top}>
        <IconButton icon="arrow_back" label="Back" onPress={onBack} testID="register-back" />
        <Text style={styles.title} numberOfLines={1} accessibilityRole="header">
          {title}
        </Text>
        <View style={styles.spacer} />
      </View>
      <StepBar step={step} style={styles.headerBar} />
    </View>
  );
}

const useStyles = makeStyles(({ colors }) => ({
  bar: { flexDirection: 'row', gap: 6 },
  segment: { flex: 1, height: 4, borderRadius: radius.sm },
  on: { backgroundColor: colors.primary },
  off: { backgroundColor: colors.skeleton },
  header: { backgroundColor: colors.page },
  top: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
  },
  title: {
    ...fonts.semibold,
    flex: 1,
    fontSize: 17,
    lineHeight: 22,
    textAlign: 'center',
    color: colors.text,
  },
  spacer: { width: 44 },
  headerBar: { paddingHorizontal: layout.gutter, paddingTop: 6 },
}));
