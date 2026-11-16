/**
 * ProgressSteps: where the person is in a short flow (registration, checkout), as one bar segment
 * per step under the words "Step 2 of 5" and the current step's name (ADR-008).
 *
 * Each step is `done`, `current` or `upcoming`. Colour is never the only sign (SPK-UX-009): the
 * words say which step this is, done segments carry a check, the current one is filled without
 * one and upcoming ones are thin. For screen readers the whole bar is one element named
 * "Step 2 of 5, Options".
 */
import { Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { Icon } from './Icon';
import { fonts, makeStyles, radius, spacing, type, useTheme } from './theme';

export type StepState = 'done' | 'current' | 'upcoming';

/** The state of each of `count` steps when `current` (0-based) is the one in progress. */
export function stepStates(count: number, current: number): StepState[] {
  return Array.from({ length: count }, (_, index) =>
    index < current ? 'done' : index === current ? 'current' : 'upcoming',
  );
}

/** "Step 2 of 5, Options". */
export function progressStepsLabel(steps: readonly string[], current: number): string {
  const index = Math.min(Math.max(current, 0), Math.max(steps.length - 1, 0));
  const name = steps[index];
  return `Step ${index + 1} of ${steps.length}${name ? `, ${name}` : ''}`;
}

export interface ProgressStepsProps {
  /** Step names, in order. */
  steps: readonly string[];
  /** Index (0-based) of the step in progress. */
  current: number;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function ProgressSteps({ steps, current, style, testID }: ProgressStepsProps) {
  const styles = useStyles();
  const { colors } = useTheme();
  const index = Math.min(Math.max(current, 0), Math.max(steps.length - 1, 0));
  const states = stepStates(steps.length, index);
  return (
    <View
      style={[styles.root, style]}
      accessible
      accessibilityLabel={progressStepsLabel(steps, index)}
      testID={testID}
    >
      <Text style={styles.count}>{`Step ${index + 1} of ${steps.length}`}</Text>
      {steps[index] ? <Text style={styles.name}>{steps[index]}</Text> : null}
      <View style={styles.bar}>
        {states.map((state, i) => (
          <View
            key={`${i}-${steps[i] ?? ''}`}
            style={[styles.segment, styles[state]]}
            testID={testID ? `${testID}-${state}` : undefined}
          >
            {state === 'done' ? <Icon name="check" size={10} color={colors.primaryText} /> : null}
          </View>
        ))}
      </View>
    </View>
  );
}

const useStyles = makeStyles(({ colors }) => ({
  root: { gap: spacing.xs },
  count: { ...type.footnote, ...fonts.semibold, color: colors.textMuted },
  name: { ...type.heading, color: colors.text },
  bar: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, marginTop: spacing.xs },
  segment: {
    flex: 1,
    height: 6,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  done: { height: 12, backgroundColor: colors.primary },
  current: { height: 12, backgroundColor: colors.primary },
  upcoming: { backgroundColor: colors.control },
}));
