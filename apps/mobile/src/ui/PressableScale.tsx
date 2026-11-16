/**
 * A pressable that draws in slightly while held (ADR-008 motion, SPK-UX-010 restrained animation):
 * it springs to `motionTokens.pressScale` (0.97) and back. While motion is reduced, and in every
 * test without a `MotionProvider` (src/ui/motion.tsx), it does not scale at all: the pressed fill
 * of the component using it is the only visual feedback, and it appears at once.
 *
 * `haptic` plays a light touch through the injected haptics service (`useHaptics`) when the press
 * lands, never on its own: whatever the press does also changes the screen or is announced
 * (SPK-UX-009). Disabled presses play nothing.
 *
 * The style and children may be functions of `{ pressed }`, as with React Native's `Pressable`.
 * Every accessibility prop is passed through; the component using it sets the role, name and state.
 * Button, IconButton and the cards of the visual system build on it.
 */
import { useCallback, useState, type ReactNode } from 'react';
import {
  Pressable,
  type GestureResponderEvent,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { useApp } from '../providers/AppProviders';
import { silentHaptics, type Haptics } from '../providers/haptics';
import { useMotion } from './motion';
import { motionTokens } from './theme';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

/** The haptic a press plays: a selection tick, a light or medium impact, or none. */
export type PressHaptic = 'selection' | 'light' | 'medium' | 'none';

export interface PressState {
  pressed: boolean;
}

export interface PressableScaleProps extends Omit<PressableProps, 'style' | 'children'> {
  style?: StyleProp<ViewStyle> | ((state: PressState) => StyleProp<ViewStyle>);
  children?: ReactNode | ((state: PressState) => ReactNode);
  /** Played when a press lands (default none). */
  haptic?: PressHaptic;
  /** Set false for a pressable that should never scale (a large row that would look jumpy). */
  scale?: boolean;
}

/**
 * The injected haptics (`useApp().services.haptics`); silent outside the app providers (a
 * component rendered on its own in a test), so no component needs the providers to render.
 */
export function useHaptics(): Haptics {
  try {
    return useApp().services.haptics;
  } catch {
    return silentHaptics;
  }
}

/** Plays `haptic` on `haptics`. */
export function playPressHaptic(haptics: Haptics, haptic: PressHaptic): void {
  if (haptic === 'selection') haptics.selection();
  else if (haptic === 'light' || haptic === 'medium') haptics.impact(haptic);
}

export function PressableScale({
  style,
  children,
  haptic = 'none',
  scale: scaleOnPress = true,
  onPress,
  onPressIn,
  onPressOut,
  ...pressable
}: PressableScaleProps) {
  const motion = useMotion();
  const haptics = useHaptics();
  const [pressed, setPressed] = useState(false);
  const scale = useSharedValue(1);
  const animated = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  const moves = scaleOnPress && !motion.reduced;

  const handlePressIn = useCallback(
    (event: GestureResponderEvent) => {
      setPressed(true);
      if (moves) scale.value = withSpring(motionTokens.pressScale, motionTokens.springs.press);
      onPressIn?.(event);
    },
    [moves, onPressIn, scale],
  );
  const handlePressOut = useCallback(
    (event: GestureResponderEvent) => {
      setPressed(false);
      if (moves) scale.value = withSpring(1, motionTokens.springs.press);
      else scale.value = 1;
      onPressOut?.(event);
    },
    [moves, onPressOut, scale],
  );
  const handlePress = useCallback(
    (event: GestureResponderEvent) => {
      playPressHaptic(haptics, haptic);
      onPress?.(event);
    },
    [haptics, haptic, onPress],
  );

  const state: PressState = { pressed };
  const resolved = typeof style === 'function' ? style(state) : style;
  return (
    <AnimatedPressable
      {...pressable}
      onPress={onPress ? handlePress : undefined}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      // No transform at all while motion is reduced: what is drawn is the plain style.
      style={moves ? [resolved, animated] : resolved}
    >
      {typeof children === 'function' ? children(state) : children}
    </AnimatedPressable>
  );
}
