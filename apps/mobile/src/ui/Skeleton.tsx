/**
 * Loading placeholders (ADR-008 visual system v2, **Proposed**): grey shapes in the layout of what
 * is loading, so the page keeps its shape (SPK-UX-008 loading).
 *
 * - `Skeleton` draws one shape: a `line` of text, a `block` (an image, a tile) or a `circle` (an
 *   avatar). `SkeletonCard` is the preset for a card with an image and two lines.
 * - Skeletons are decorative and always hidden from VoiceOver and TalkBack. What a screen reader
 *   hears while something loads comes from the loading state that draws them (StateView's one busy
 *   progress indicator, "Loading …"), never from the shapes.
 * - With motion on, a highlight (`skeletonHighlight`) slowly fades in and out over the fill
 *   (`skeleton`); with motion reduced, and in every test without a `MotionProvider`, the shapes
 *   are static.
 */
import { useEffect, type ReactNode } from 'react';
import { StyleSheet, View, type DimensionValue, type ViewStyle } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { useMotion } from './motion';
import { continuousCorners, elevation, makeStyles, motionTokens, radius, spacing } from './theme';

export type SkeletonShape = 'line' | 'block' | 'circle';

export interface SkeletonProps {
  shape?: SkeletonShape;
  /** Width of a line or block (default the full width; a line of text is often 60% or so). */
  width?: DimensionValue;
  /** Height of a line (default 14) or a block (default 120). */
  height?: number;
  /** Diameter of a circle (default 40). */
  size?: number;
  testID?: string;
}

/** Hidden from screen readers on both platforms. */
const HIDDEN = {
  accessibilityElementsHidden: true,
  importantForAccessibility: 'no-hide-descendants',
} as const;

/** One half of the shimmer: three slow steps, so the highlight breathes rather than flickers. */
const SHIMMER_STEPS = 3;

const useStyles = makeStyles(({ colors }) => ({
  fill: { backgroundColor: colors.skeleton },
  highlight: { backgroundColor: colors.skeletonHighlight },
}));

function Shimmer() {
  const motion = useMotion();
  const themed = useStyles();
  const opacity = useSharedValue(0);
  const half = motion.duration('slow') * SHIMMER_STEPS;
  useEffect(() => {
    if (motion.reduced) {
      cancelAnimation(opacity);
      opacity.value = 0;
      return undefined;
    }
    opacity.value = withRepeat(
      withTiming(1, { duration: half, easing: Easing.bezier(...motionTokens.easings.standard) }),
      -1,
      true,
    );
    return () => cancelAnimation(opacity);
  }, [motion.reduced, half, opacity]);
  const animated = useAnimatedStyle(() => ({ opacity: opacity.value }));
  // Nothing is drawn over the fill while motion is reduced: the shape is static.
  if (motion.reduced) return null;
  return (
    <Animated.View
      style={[StyleSheet.absoluteFill, themed.highlight, animated]}
      testID="skeleton-shimmer"
    />
  );
}

/** The size and corners of a shape. */
export function skeletonShapeStyle({
  shape = 'line',
  width,
  height,
  size = 40,
}: Pick<SkeletonProps, 'shape' | 'width' | 'height' | 'size'>): ViewStyle {
  switch (shape) {
    case 'circle':
      return { width: size, height: size, borderRadius: size / 2 };
    case 'block':
      return {
        width: width ?? '100%',
        height: height ?? 120,
        borderRadius: radius.image,
        ...continuousCorners,
      };
    case 'line': {
      const h = height ?? 14;
      return { width: width ?? '100%', height: h, borderRadius: h / 2 };
    }
  }
}

export function Skeleton({ shape = 'line', width, height, size, testID }: SkeletonProps) {
  const themed = useStyles();
  return (
    <View
      {...HIDDEN}
      testID={testID}
      style={[styles.shape, themed.fill, skeletonShapeStyle({ shape, width, height, size })]}
    >
      <Shimmer />
    </View>
  );
}

const useCardStyles = makeStyles((theme) => ({
  card: { ...elevation(theme, 'card') },
}));

/** A group of skeletons, hidden from screen readers as one. */
export function SkeletonGroup({ children, testID }: { children: ReactNode; testID?: string }) {
  return (
    <View {...HIDDEN} testID={testID} style={styles.group}>
      {children}
    </View>
  );
}

/** A card loading: an image block and two lines of text, on the card surface. */
export function SkeletonCard({
  imageHeight = 160,
  testID,
}: {
  imageHeight?: number;
  testID?: string;
}) {
  const card = useCardStyles();
  return (
    <View {...HIDDEN} testID={testID} style={[styles.card, card.card]}>
      <Skeleton shape="block" height={imageHeight} />
      <View style={styles.cardText}>
        <Skeleton shape="line" width="70%" height={18} />
        <Skeleton shape="line" width="45%" />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  shape: { overflow: 'hidden' },
  group: { gap: spacing.sm },
  card: {
    borderRadius: radius.lg,
    ...continuousCorners,
    padding: spacing.md,
    gap: spacing.md,
  },
  cardText: { gap: spacing.sm, paddingHorizontal: spacing.xs, paddingBottom: spacing.xs },
});
