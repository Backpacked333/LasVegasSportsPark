/**
 * SCR-C-39 "Update required" (§4.13, SPK-AT-027). Shown over everything when the API answers that
 * this build is below the minimum supported version. The answer itself (CLIENT_UPDATE_REQUIRED,
 * HTTP 426) is proposed in DEC-092, and the minimum version and update behaviour are DEC-061
 * (Technical lead/operator); the store links depend on store accounts that do not exist yet.
 */
import type { UpdateRequiredError } from '@sportspark/api-client';
import { StyleSheet, Text, View } from 'react-native';
import { StatusBadge } from '../../ui/StatusBadge';
import { colors, spacing, type } from '../../ui/theme';

export function UpdateRequiredScreen({
  error,
  appVersion,
}: {
  error: UpdateRequiredError;
  appVersion: string;
}) {
  return (
    <View style={styles.overlay} accessibilityViewIsModal testID="update-required">
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
    </View>
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
