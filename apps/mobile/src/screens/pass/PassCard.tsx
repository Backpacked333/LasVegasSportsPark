/**
 * SCR-C-05 the pass as a night card (ADR-008 visual system v2, PA-11 customer words): a night
 * pitch surface with the lines of a pitch drawn over it, holding the reference in large tabular
 * figures, "Show this at the front desk" and "Works offline".
 *
 * - The pitch lines are drawn with `react-native-svg` (no image file) and are decorative: hidden
 *   from VoiceOver and TalkBack. The words carry the meaning (SPK-UX-009).
 * - No name, family or child detail is printed on the card (SPK-ENTRY-002), and no scannable
 *   symbol is drawn until the desk scanners are decided (the "More" fold of the pass says so).
 * - The reference is one element for screen readers, spelled out character by character so it is
 *   read as written, then "Show this at the front desk." (SPK-UX-009).
 * - On screen it is shown in groups of four (the stored value is unchanged) in a monospaced face
 *   (Menlo, the platform monospace) whose zero is slashed or dotted and whose l, I and 1 differ, and its digits are drawn in the
 *   floodlight colour so a digit never passes for a letter when it is read out at the desk.
 * - The words sit on solid plates of the card's own colour, so the pitch lines never run through
 *   text.
 * - Fills the height of the screen it sits on (most of the window), so the pass reads at a glance
 *   at a busy desk (SPK-UX-010); with large text it grows instead of clipping.
 */
import type { ReactNode } from 'react';
import { Platform, Text as RNText, StyleSheet, View, useWindowDimensions } from 'react-native';
import Svg, { Circle, Line, Rect } from 'react-native-svg';
import { Icon } from '../../ui/Icon';
import { Text } from '../../ui/Text';
import {
  continuousCorners,
  fonts,
  layout,
  makeStyles,
  radius,
  spacing,
  tabular,
  type,
  useTheme,
} from '../../ui/theme';

/** "spk_ AAAA BBBB …": groups of four so the reference can be read out at the desk. */
export function groupReference(reference: string): string {
  return reference.match(/.{1,4}/g)?.join(' ') ?? reference;
}

/**
 * The reference's runs for drawing: each group of four, split into runs of digits and of other
 * characters (`"aB12" → [["aB", false], ["12", true]]`).
 */
export function referenceRuns(group: string): [string, boolean][] {
  return (group.match(/\d+|\D+/g) ?? []).map((run) => [run, /^\d/.test(run)]);
}

/** A monospaced face with distinct l/I/1 and O/0 on each platform. */
const REFERENCE_FONT = Platform.select({
  ios: 'Menlo',
  android: 'monospace',
  default: 'ui-monospace, Menlo, Consolas, "Roboto Mono", monospace',
});

/** What a screen reader hears for the reference: every character on its own, then the action. */
export function referenceLabel(reference: string): string {
  return `Facility pass reference: ${groupReference(reference).split('').join(' ')}. Show this at the front desk.`;
}

/** The share of the window the card fills: most of it, leaving room for the state line below. */
const CARD_HEIGHT_SHARE = 0.62;

/** The lines of a pitch, seen from above, as a decorative pattern behind the card's content. */
export function PitchLines({ color }: { color: string }) {
  return (
    <View
      style={StyleSheet.absoluteFill}
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      testID="pass-pitch-lines"
    >
      <Svg width="100%" height="100%" viewBox="0 0 100 160" preserveAspectRatio="xMidYMid slice">
        {/* Touchline and goal lines. */}
        <Rect
          x={6}
          y={6}
          width={88}
          height={148}
          rx={1.5}
          stroke={color}
          strokeWidth={0.6}
          fill="none"
        />
        {/* Halfway line, centre circle and spot. */}
        <Line x1={6} y1={80} x2={94} y2={80} stroke={color} strokeWidth={0.6} />
        <Circle cx={50} cy={80} r={13} stroke={color} strokeWidth={0.6} fill="none" />
        <Circle cx={50} cy={80} r={0.9} fill={color} />
        {/* Penalty and goal areas at each end. */}
        <Rect x={24} y={6} width={52} height={22} stroke={color} strokeWidth={0.6} fill="none" />
        <Rect x={37} y={6} width={26} height={8} stroke={color} strokeWidth={0.6} fill="none" />
        <Rect x={24} y={132} width={52} height={22} stroke={color} strokeWidth={0.6} fill="none" />
        <Rect x={37} y={146} width={26} height={8} stroke={color} strokeWidth={0.6} fill="none" />
        <Circle cx={50} cy={22} r={0.9} fill={color} />
        <Circle cx={50} cy={138} r={0.9} fill={color} />
      </Svg>
    </View>
  );
}

/** The night surface with the pitch lines; `fill` makes it most of the window tall. */
export function NightCard({
  children,
  fill = false,
  testID,
}: {
  children: ReactNode;
  fill?: boolean;
  testID?: string;
}) {
  const styles = useStyles();
  const { colors } = useTheme();
  const { height } = useWindowDimensions();
  return (
    <View
      style={[styles.card, fill ? { minHeight: Math.round(height * CARD_HEIGHT_SHARE) } : null]}
      testID={testID}
    >
      <PitchLines color={colors.nightLine} />
      {children}
    </View>
  );
}

/** The pass itself: the reference, where to show it, and that it works offline. */
export function PassCard({ reference, issued }: { reference: string; issued: string }) {
  const styles = useStyles();
  const { colors } = useTheme();
  return (
    <NightCard fill testID="pass-card">
      <View style={[styles.top, styles.plate]}>
        <Icon name="sports_soccer" size={22} color={colors.floodlight} />
        <Text variant="label" tone="inverse">
          Facility pass
        </Text>
      </View>
      <View
        style={[styles.reference, styles.plate]}
        accessible
        // Spelled out, so VoiceOver and TalkBack read the reference itself (SPK-UX-009).
        accessibilityLabel={referenceLabel(reference)}
        testID="pass-reference"
      >
        <Text tabular selectable style={styles.referenceText}>
          {groupReference(reference)
            .split(' ')
            .map((group, g) => (
              // Plain nested spans: they inherit the reference's face and colour.
              <RNText key={`${group}-${g}`}>
                {g > 0 ? ' ' : ''}
                {referenceRuns(group).map(([run, digits], r) =>
                  digits ? (
                    <RNText key={r} style={styles.digits}>
                      {run}
                    </RNText>
                  ) : (
                    run
                  ),
                )}
              </RNText>
            ))}
        </Text>
      </View>
      <View style={[styles.bottom, styles.plate]} testID="pass-words">
        <Text variant="title3" tone="inverse">
          Show this at the front desk
        </Text>
        <View style={styles.chip}>
          <Icon name="wifi_off" size={18} color={colors.floodlight} />
          <Text variant="footnote" tone="inverse" style={styles.chipText}>
            Works offline
          </Text>
        </View>
        <Text variant="footnote" style={styles.issued} testID="pass-issued">
          {issued}
        </Text>
      </View>
    </NightCard>
  );
}

const useStyles = makeStyles(({ colors, dark }) => ({
  card: {
    marginHorizontal: layout.gutter,
    marginTop: spacing.sm,
    padding: spacing.xl,
    gap: spacing.xl,
    borderRadius: radius.xl,
    ...continuousCorners,
    overflow: 'hidden',
    backgroundColor: colors.night,
    // A hairline keeps the pass's edge on a page that is itself dark (Legends mode).
    borderWidth: 1,
    borderColor: dark ? colors.nightLine : colors.night,
    justifyContent: 'space-between',
  },
  top: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  // A solid plate of the card's colour behind words, so no pitch line crosses them.
  plate: {
    alignSelf: 'flex-start',
    backgroundColor: colors.night,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    marginHorizontal: -spacing.sm,
  },
  reference: { paddingVertical: spacing.md },
  referenceText: {
    ...tabular(type.largeTitle),
    fontFamily: REFERENCE_FONT,
    fontWeight: '700',
    fontSize: 40,
    lineHeight: 50,
    letterSpacing: 0.5,
    color: colors.onNight,
  },
  digits: { color: colors.floodlight },
  bottom: { gap: spacing.md },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: spacing.xs,
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    backgroundColor: colors.nightRaised,
    borderWidth: 1,
    borderColor: colors.nightLine,
  },
  chipText: { ...fonts.semibold },
  issued: { color: colors.onNightBody },
}));
