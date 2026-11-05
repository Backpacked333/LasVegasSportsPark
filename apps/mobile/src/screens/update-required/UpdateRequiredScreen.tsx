/**
 * SCR-C-39 "Update required" (§4.13, SPK-AT-027). Shown over everything when the API answers that
 * this build is below the minimum supported version. The answer itself (CLIENT_UPDATE_REQUIRED,
 * HTTP 426) is proposed in DEC-092, and the minimum version and update behaviour are DEC-061
 * (Technical lead/operator); the store links depend on store accounts that do not exist yet.
 *
 * It is announced to screen readers once, when it appears, like every other state view
 * (`ui/announce`: a live region on Android, an announcement on iOS; SPK-UX-009, NA-A01), and the app
 * it covers is hidden from them while it shows (`navigation/UpdateGate`). The app underneath keeps
 * reading while covered, and each read answers 426 again: the words never change, so a later answer
 * is not announced again, and the providers keep the first answer (its reference with it), so the
 * Android live region's content does not change either (R4-CLIENTS-A11Y-COPY-04).
 */
import type { UpdateRequiredError } from '@sportspark/api-client';
import { StyleSheet, Text } from 'react-native';
import { LiveRegion, sentences } from '../../ui/announce';
import { StatusBadge } from '../../ui/StatusBadge';
import { colors, spacing, type } from '../../ui/theme';

/** What a screen reader hears when the update screen appears, with the next action. */
export const UPDATE_REQUIRED_ANNOUNCEMENT = sentences(
  'Update required',
  'This version of the app is no longer supported',
  "Update the app from your device's app store",
);

export function UpdateRequiredScreen({
  error,
  appVersion,
}: {
  error: UpdateRequiredError;
  appVersion: string;
}) {
  return (
    <LiveRegion
      style={styles.overlay}
      accessibilityViewIsModal
      announcement={UPDATE_REQUIRED_ANNOUNCEMENT}
      testID="update-required"
    >
      <StatusBadge tone="danger" label="Update required" />
      <Text style={styles.title} accessibilityRole="header">
        This version of the app is no longer supported
      </Text>
      <Text style={styles.body}>
        You have version {appVersion}
        {error.minimumVersion ? `; version ${error.minimumVersion} or later is required` : ''}.
        Update the app from your device's app store to continue.
      </Text>
      {error.correlationId ? (
        <Text style={styles.caption} selectable>
          Reference: {error.correlationId}
        </Text>
      ) : null}
    </LiveRegion>
  );
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFill,
    backgroundColor: colors.background,
    padding: spacing.xl,
    gap: spacing.md,
    justifyContent: 'center',
  },
  title: { ...type.title, color: colors.text },
  body: { ...type.body, color: colors.text },
  caption: { ...type.caption, color: colors.textMuted },
});
