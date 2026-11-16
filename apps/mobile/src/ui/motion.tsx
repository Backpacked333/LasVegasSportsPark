/**
 * Motion: whether the app may move things, and for how long (ADR-008, SPK-UX-009). Every animated
 * component asks `useMotion()`; none reads the device setting itself.
 *
 * - `reduced` follows the device's "reduce motion" setting and its change event.
 * - `duration(token)` is the token's length in milliseconds, or 0 while motion is reduced, so a
 *   component with reduced motion jumps straight to its end state.
 *
 * Reduced is the default: a tree without `MotionProvider` (every screen test) gets `reduced: true`,
 * the same rule as `GlassProvider` (src/ui/GlassSurface.tsx), so nothing moves in a test and no
 * screen depends on an animation finishing. Inside a provider, motion stays reduced until the
 * device has answered, and when it cannot answer.
 *
 * The durations are the motion tokens of `src/ui/theme.ts` (`motionTokens`, `durationsFor`), the
 * **Proposed** values of the visual system v2 (ADR-008).
 */
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { AccessibilityInfo, type EmitterSubscription } from 'react-native';
import { durationsFor, motionTokens, type DurationToken } from './theme';

export const MOTION_DURATIONS = motionTokens.durations;

export type MotionToken = DurationToken;

export interface Motion {
  /** The device asked for reduced motion, has not answered yet, or there is no provider. */
  reduced: boolean;
  /** Milliseconds for `token`; 0 while motion is reduced. */
  duration(token: MotionToken): number;
}

/** The motion for a given setting. Pure, so the rule is tested without a device. */
export function motionFor(reduced: boolean): Motion {
  return {
    reduced,
    duration: (token) => durationsFor(reduced)[token],
  };
}

const REDUCED = motionFor(true);
const FULL = motionFor(false);

const MotionContext = createContext<Motion>(REDUCED);

export function useMotion(): Motion {
  return useContext(MotionContext);
}

/**
 * Asks the device once, then follows its "reduce motion" setting. `reduced` fixes the answer
 * (tests and previews).
 */
export function MotionProvider({ reduced, children }: { reduced?: boolean; children: ReactNode }) {
  const [detected, setDetected] = useState(true);
  useEffect(() => {
    if (reduced !== undefined) return undefined;
    let live = true;
    const apply = (value: boolean) => {
      if (live) setDetected(value);
    };
    AccessibilityInfo.isReduceMotionEnabled()
      .then(apply)
      .catch(() => apply(true));
    // The web build's AccessibilityInfo returns no subscription when the browser cannot report
    // the setting.
    const subscription: EmitterSubscription | undefined = AccessibilityInfo.addEventListener(
      'reduceMotionChanged',
      apply,
    );
    return () => {
      live = false;
      subscription?.remove();
    };
  }, [reduced]);
  const value = reduced ?? detected;
  const motion = useMemo(() => (value ? REDUCED : FULL), [value]);
  return <MotionContext.Provider value={motion}>{children}</MotionContext.Provider>;
}
