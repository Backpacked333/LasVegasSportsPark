/**
 * GlassSurface: the one place the customer app asks the device for glass (ADR-001). Screens and
 * navigation use this primitive and never import the native packages themselves.
 *
 * - `liquid`: the system's liquid glass, where the device offers it (iOS 26 and later).
 * - `blur`: a system material blur on earlier iOS.
 * - `solid`: an opaque themed surface everywhere else (Android, web), whenever the person has
 *   asked the device to reduce transparency (SPK-UX-009), and until the device has answered.
 *
 * `solid` is the default: a tree without `GlassProvider` (every screen test) renders it, so a
 * screen never depends on glass being there.
 */
import { BlurView } from 'expo-blur';
import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import {
  AccessibilityInfo,
  Platform,
  View,
  type ColorValue,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useTheme } from './theme';

export type GlassMode = 'liquid' | 'blur' | 'solid';

/** What a device with these facts gets. Pure, so the rule is tested without a device. */
export function glassModeFor(device: {
  os: string;
  liquidGlass: boolean;
  reduceTransparency: boolean;
}): GlassMode {
  if (device.reduceTransparency || device.os !== 'ios') return 'solid';
  return device.liquidGlass ? 'liquid' : 'blur';
}

const GlassModeContext = createContext<GlassMode>('solid');

export function useGlassMode(): GlassMode {
  return useContext(GlassModeContext);
}

function liquidGlassOffered(): boolean {
  try {
    return isLiquidGlassAvailable();
  } catch {
    // A build without the native module (or a test runtime): no glass, never a crash.
    return false;
  }
}

/**
 * Asks the device once, then follows its "reduce transparency" setting. `mode` fixes the answer
 * (tests and previews).
 */
export function GlassProvider({ mode, children }: { mode?: GlassMode; children: ReactNode }) {
  const [detected, setDetected] = useState<GlassMode>('solid');
  useEffect(() => {
    // Off iOS the answer is always solid (glassModeFor), so the device is not asked: the web has
    // no reduce-transparency setting to ask about.
    if (mode || Platform.OS !== 'ios') return undefined;
    let live = true;
    const apply = (reduceTransparency: boolean) => {
      if (!live) return;
      setDetected(
        glassModeFor({ os: Platform.OS, liquidGlass: liquidGlassOffered(), reduceTransparency }),
      );
    };
    AccessibilityInfo.isReduceTransparencyEnabled()
      .then(apply)
      .catch(() => apply(true));
    const subscription = AccessibilityInfo.addEventListener('reduceTransparencyChanged', apply);
    return () => {
      live = false;
      subscription.remove();
    };
  }, [mode]);
  return <GlassModeContext.Provider value={mode ?? detected}>{children}</GlassModeContext.Provider>;
}

export interface GlassSurfaceProps {
  style?: StyleProp<ViewStyle>;
  /** Coloured glass (a hero band): the colour that carries the labels on it. */
  tint?: ColorValue;
  /** What `solid` paints; defaults to the theme's card colour, or to `tint` when one is given. */
  solidColor?: ColorValue;
  testID?: string;
  children?: ReactNode;
}

export function GlassSurface({ style, tint, solidColor, testID, children }: GlassSurfaceProps) {
  const mode = useGlassMode();
  const { colors, dark } = useTheme();
  if (mode === 'liquid') {
    return (
      <GlassView
        style={style}
        glassEffectStyle="regular"
        colorScheme={dark ? 'dark' : 'light'}
        {...(tint ? { tintColor: tint } : {})}
        testID={testID}
      >
        {children}
      </GlassView>
    );
  }
  // A tinted surface has nothing to gain from a blur of the plain page behind it.
  if (mode === 'blur' && !tint) {
    return (
      <BlurView
        style={style}
        intensity={70}
        tint={dark ? 'systemChromeMaterialDark' : 'systemChromeMaterialLight'}
        testID={testID}
      >
        {children}
      </BlurView>
    );
  }
  return (
    <View
      style={[style, { backgroundColor: solidColor ?? tint ?? colors.background }]}
      testID={testID}
    >
      {children}
    </View>
  );
}
