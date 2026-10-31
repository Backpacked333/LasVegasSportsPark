/**
 * Screen-reader announcements of what appears after an action or an answer (SPK-UX-009; NA-A01
 * "every status change is announced, errors are announced"): a failure, "No answer yet", "This
 * may already have been done", a success, a field error.
 *
 * React Native's `accessibilityLiveRegion` is Android only: TalkBack reads a polite live region
 * when it appears or changes, but VoiceOver has no live regions. So the same words are posted to
 * VoiceOver with `AccessibilityInfo.announceForAccessibilityWithOptions`, queued behind what it is
 * reading (polite: never interrupting). Each platform hears a result once: Android through the
 * live region, iOS through the announcement.
 *
 * - `LiveRegion`: a View that is a polite live region on Android and, on iOS, announces
 *   `announcement` when it first renders and again whenever the words or the `occurrence` change
 *   (pass the error, so a second identical failure is announced too).
 * - `LiveText`: the same for one line of text, such as a field error.
 * - `useAnnouncement`: the iOS announcement alone, for words that appear inside a view that is
 *   already a live region (a second live region inside one would make TalkBack read it twice).
 *
 * Every live region in the app is one of these: `accessibilityLiveRegion` is set nowhere else
 * (src/ui/__tests__/announce.test.tsx checks the sources), so no result is silent on iOS. The
 * words are the visible ones without glyphs, codes or ages that change while shown. Acceptance
 * with VoiceOver and TalkBack on devices is still pending (§6.2, native acceptance matrix NA-A01).
 */
import { useEffect, type ReactNode } from 'react';
import {
  AccessibilityInfo,
  Platform,
  Text,
  View,
  type TextProps,
  type ViewProps,
} from 'react-native';

/** Posts `message` to VoiceOver, queued behind current speech; Android uses live regions. */
export function announceOnIos(message: string): void {
  if (Platform.OS !== 'ios' || message.trim() === '') return;
  AccessibilityInfo.announceForAccessibilityWithOptions(message, { queue: true });
}

/**
 * Announces `message` on iOS when it is first given and whenever it (or `occurrence`) changes;
 * nothing while it is null.
 */
export function useAnnouncement(message: string | null | undefined, occurrence?: unknown): void {
  useEffect(() => {
    if (message) announceOnIos(message);
  }, [message, occurrence]);
}

export type LiveRegionProps = Omit<ViewProps, 'accessibilityLiveRegion'> & {
  /** What a screen reader hears when this appears: the visible words, without glyphs or codes. */
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
