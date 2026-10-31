/**
 * Screen-reader announcements of what appears after an action or an answer (SPK-UX-009; NA-A01
 * "every status change is announced, errors are announced with their next action"): a failure,
 * "No answer yet", "This may already have been done", a payment's outcome, a success, a field
 * error.
 *
 * React Native's `accessibilityLiveRegion` is Android only: TalkBack reads a polite live region
 * when it appears or changes, but VoiceOver has no live regions. So the same words are posted to
 * VoiceOver with `AccessibilityInfo.announceForAccessibilityWithOptions`, queued behind what it is
 * reading (polite: never interrupting).
 *
 * - `LiveRegion`: a View that is a polite live region on Android and, on iOS, announces
 *   `announcement` when it first renders and again whenever the words or the `occurrence` change
 *   (pass the error, so a second identical failure is announced too).
 * - `LiveText`: the same for one line of text, such as a field error.
 * - `useAnnouncement`: the iOS announcement alone, for words that appear inside a view that is
 *   already a live region (a second live region inside one would make TalkBack read it twice).
 *
 * Only what is in view is announced, once:
 * - expo-router keeps visited tabs and the stack below the top screen mounted. A result on one of
 *   those hidden screens is not announced (`useScreenFocused`), as TalkBack does not read a live
 *   region that is not on screen.
 * - The connectivity banner is on every screen, so its words are announced once for the app by
 *   `ConnectivityAnnouncer` (src/connectivity/ConnectivityBanner.tsx, rendered by the root
 *   navigator), never by each banner; StateView's "You are offline" leaves it to the banner.
 * - The same words posted twice in one pass of effects (two views showing the same answer at the
 *   same moment) are posted once (`announceOnIos`).
 *
 * Every live region in the app is one of these: `accessibilityLiveRegion` is set nowhere else
 * (src/ui/__tests__/announce.test.tsx checks the sources). Which result views are announced, and
 * which are not yet, is in the app README ("Results are announced to screen readers"). The words
 * are the visible ones without glyphs, codes or ages that change while shown, with the next
 * action. Acceptance with VoiceOver and TalkBack on devices is still pending (§6.2, native
 * acceptance matrix NA-A01, NA-A02).
 */
import { useCallback, useContext, useEffect, type ReactNode } from 'react';
import {
  AccessibilityInfo,
  Platform,
  Text,
  View,
  type TextProps,
  type ViewProps,
} from 'react-native';
// The navigation context expo-router's navigators provide to each screen (expo-router 57 ships its
// own copy of React Navigation; its `useIsFocused` throws outside a navigator, this does not).
import { NavigationContext } from 'expo-router/build/react-navigation/core/NavigationContext';

/** Words posted in the current pass of effects; cleared once that pass has finished. */
const postedThisPass = new Set<string>();

/**
 * Posts `message` to VoiceOver, queued behind current speech; Android uses live regions. The same
 * words posted again before the current JavaScript task ends (two views showing the same answer
 * in one render) are posted once; a later identical answer is posted again.
 */
export function announceOnIos(message: string): void {
  if (Platform.OS !== 'ios' || message.trim() === '') return;
  if (postedThisPass.has(message)) return;
  if (postedThisPass.size === 0) void Promise.resolve().then(() => postedThisPass.clear());
  postedThisPass.add(message);
  AccessibilityInfo.announceForAccessibilityWithOptions(message, { queue: true });
}

/**
 * Whether the screen this component is on is the one in view, as `() => boolean`. Outside a
 * navigator (the root layout, or a test that renders a screen by itself) nothing is hidden.
 */
export function useScreenFocused(): () => boolean {
  const navigation = useContext(NavigationContext);
  // A screen's navigation object is the same for its whole life, so this function is too.
  return useCallback(() => navigation?.isFocused() ?? true, [navigation]);
}

/**
 * Announces `message` on iOS when it is first given and whenever it (or `occurrence`) changes,
 * while its screen is in view; nothing while it is null.
 */
export function useAnnouncement(message: string | null | undefined, occurrence?: unknown): void {
  const focused = useScreenFocused();
  useEffect(() => {
    if (message && focused()) announceOnIos(message);
  }, [message, occurrence, focused]);
}

export type LiveRegionProps = Omit<ViewProps, 'accessibilityLiveRegion'> & {
  /**
   * What a screen reader hears when this appears: the visible words, without glyphs or codes,
   * with the next action. Null for a region announced elsewhere on iOS (the connectivity banner).
   */
  announcement: string | null;
  /** Announce again when this changes although the words did not (a new error object). */
  occurrence?: unknown;
  children?: ReactNode;
};

export function LiveRegion({ announcement, occurrence, children, ...view }: LiveRegionProps) {
  useAnnouncement(announcement, occurrence);
  return (
    <View {...view} accessibilityLiveRegion="polite">
      {children}
    </View>
  );
}

export type LiveTextProps = Omit<TextProps, 'accessibilityLiveRegion'> & {
  announcement: string | null;
  occurrence?: unknown;
  children?: ReactNode;
};

export function LiveText({ announcement, occurrence, children, ...text }: LiveTextProps) {
  useAnnouncement(announcement, occurrence);
  return (
    <Text {...text} accessibilityLiveRegion="polite">
      {children}
    </Text>
  );
}

/** "Label. Description": the words of a badge and its explanation, as one announcement. */
export function sentences(...parts: (string | null | undefined | false)[]): string {
  return parts
    .filter((p): p is string => typeof p === 'string' && p.trim() !== '')
    .map((p) => p.trim())
    .map((p) => (/[.!?…]$/.test(p) ? p : `${p}.`))
    .join(' ');
}
