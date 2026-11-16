/**
 * Haptics (ADR-008): a light touch that confirms what the screen already shows. Haptics are never
 * the only feedback (SPK-UX-009): every event that plays one also changes what is on screen or is
 * announced.
 *
 * Screens ask the injected service (`useApp().services.haptics`), never expo-haptics itself, so
 * tests record what would have played (`RecordingHaptics`) and the web build plays nothing. The
 * device's own setting for system haptics applies: the operating system skips them when the
 * person has turned them off. Not verified on physical devices here (§6.2).
 */
import * as ExpoHaptics from 'expo-haptics';
import { Platform } from 'react-native';

export type ImpactWeight = 'light' | 'medium';

export interface Haptics {
  /** A choice changed: a tab, a chip, a segment, a date. */
  selection(): void;
  /** A press that commits a small action (a card opened, a sheet snapped). */
  impact(weight: ImpactWeight): void;
  /** A command succeeded (registration confirmed, payment recorded). */
  success(): void;
  /** Something needs the person's attention (a refusal, an outcome not yet known). */
  warning(): void;
}

/** What the recorder saw, in order. */
export type HapticEvent = 'selection' | 'impact:light' | 'impact:medium' | 'success' | 'warning';

/** Plays nothing. The web build, and any platform without a haptic engine. */
export const silentHaptics: Haptics = {
  selection() {},
  impact() {},
  success() {},
  warning() {},
};

/** A haptic that fails (no engine, the app in the background) is skipped, never an error. */
function play(effect: () => Promise<void>): void {
  try {
    effect().catch(() => undefined);
  } catch {
    // The native module is missing in this build: nothing to play.
  }
}

/** The device's haptic engine through expo-haptics. */
export const deviceHaptics: Haptics = {
  selection: () => play(() => ExpoHaptics.selectionAsync()),
  impact: (weight) =>
    play(() =>
      ExpoHaptics.impactAsync(
        weight === 'medium'
          ? ExpoHaptics.ImpactFeedbackStyle.Medium
          : ExpoHaptics.ImpactFeedbackStyle.Light,
      ),
    ),
  success: () =>
    play(() => ExpoHaptics.notificationAsync(ExpoHaptics.NotificationFeedbackType.Success)),
  warning: () =>
    play(() => ExpoHaptics.notificationAsync(ExpoHaptics.NotificationFeedbackType.Warning)),
};

/** The haptics for this platform: the device's engine on iOS and Android, nothing on the web. */
export function platformHaptics(os: string = Platform.OS): Haptics {
  return os === 'ios' || os === 'android' ? deviceHaptics : silentHaptics;
}

/** Test double: records each event instead of playing it. */
export class RecordingHaptics implements Haptics {
  readonly events: HapticEvent[] = [];

  selection(): void {
    this.events.push('selection');
  }

  impact(weight: ImpactWeight): void {
    this.events.push(`impact:${weight}`);
  }

  success(): void {
    this.events.push('success');
  }

  warning(): void {
    this.events.push('warning');
  }

  clear(): void {
    this.events.length = 0;
  }
}
