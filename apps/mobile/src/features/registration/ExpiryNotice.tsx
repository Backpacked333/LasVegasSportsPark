/**
 * Server-owned expiry with an informational countdown (SPK-REG-006: "A client countdown is
 * informational; the server controls expiry"), used for held places (SCR-C-11, SCR-C-14) and
 * waitlist offers (SCR-C-16). When the device clock passes the expiry the screen re-reads the
 * record instead of deciding the outcome itself.
 */
import { useEffect, useRef } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useNow } from '../../providers/AppProviders';
import { StatusBadge, type StatusBadgeProps } from '../../ui/StatusBadge';
import { colors, spacing, type } from '../../ui/theme';
import { hasPassed, timeLeftPhrase } from './format';

export function ExpiryNotice({
  expiresAt,
  status,
  explanation,
  onLapsed,
  testID,
}: {
  expiresAt: string;
  status: StatusBadgeProps;
  /** What the expiry means, e.g. "The server releases the place at this time." */
  explanation: string;
  /** Called once when the device clock passes the expiry: re-read the record. */
  onLapsed?: () => void;
  testID?: string;
}) {
  const now = useNow(15_000);
  const lapsed = hasPassed(expiresAt, now);
  const notified = useRef(false);
  useEffect(() => {
    if (lapsed && !notified.current) {
      notified.current = true;
      onLapsed?.();
    }
  }, [lapsed, onLapsed]);
  return (
    <View style={styles.box} testID={testID}>
      <StatusBadge {...status} />
      {lapsed ? null : (
        <Text
          style={styles.body}
          accessibilityLabel={`Countdown: ${timeLeftPhrase(expiresAt, now)}`}
        >
          {`Countdown: ${timeLeftPhrase(expiresAt, now)}`}
        </Text>
      )}
      <Text style={styles.caption}>{explanation}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, gap: spacing.xs },
  body: { ...type.body, color: colors.text },
  caption: { ...type.caption, color: colors.textMuted },
});
