/**
 * Shake (handoff M 5b: "A wrong code shakes the boxes and clears them"; ADR-008 motion): moves its
 * children side to side once each time `trigger` changes. With reduced motion nothing moves (the
 * screen says what happened in words, so the shake is never the only cue).
 */
import { useEffect, type ReactNode } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { useMotion } from './motion';

export function Shake({
  trigger,
  children,
  style,
}: {
  /** Each new value shakes once; 0 never does. */
  trigger: number;
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const motion = useMotion();
  const offset = useSharedValue(0);
  useEffect(() => {
    if (trigger === 0 || motion.reduced) return;
    const step = Math.max(1, Math.round(motion.duration('slow') / 6));
    offset.value = withSequence(
      withTiming(-10, { duration: step }),
      withTiming(10, { duration: step }),
      withTiming(-6, { duration: step }),
      withTiming(6, { duration: step }),
      withTiming(0, { duration: step }),
    );
  }, [trigger, motion, offset]);
  const moving = useAnimatedStyle(() => ({ transform: [{ translateX: offset.value }] }));
  return <Animated.View style={[style, moving]}>{children}</Animated.View>;
}
