/**
 * Quick access to the facility pass (SCR-C-05) and the notification inbox (SCR-C-06) from the
 * header of every destination, without a permanent tab (SPK-UX-002): a night "Pass" pill and a
 * round inbox button. The words, not the icons, name each one to screen readers (SPK-UX-009).
 *
 * The inbox button carries the unread count (`GET /v1/me/inbox/unread-count`, SPK-UX-003) as a
 * small badge with the number and in its accessible name ("Notification inbox, 3 unread"). While
 * the count is loading, failed or zero there is no badge and the plain name, never a guess.
 */
import { useRouter } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { inboxButtonLabel, unreadBadgeText, useInboxUnreadCount } from '../api/inbox-unread';
import { Icon } from '../ui/Icon';
import { colors, fonts, MIN_TOUCH_SIZE, radius, spacing } from '../ui/theme';

export function QuickAccess() {
  const router = useRouter();
  const unread = useInboxUnreadCount();
  const badge = unread.data ? unreadBadgeText(unread.data) : null;
  return (
    <View style={styles.row}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Facility pass"
        onPress={() => router.push('/pass')}
        hitSlop={4}
        style={({ pressed }) => [styles.pass, pressed && styles.pressed]}
        testID="quick-pass"
      >
        <Icon name="qr_code_2" size={19} color={colors.floodlight} />
        <Text style={styles.passText}>Pass</Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={inboxButtonLabel(unread.data)}
        onPress={() => router.push('/inbox')}
        hitSlop={4}
        style={({ pressed }) => [styles.inbox, pressed && styles.pressed]}
        testID="quick-inbox"
      >
        <Icon name="notifications" size={21} color={colors.text} />
        {badge ? (
          // Part of the button's name above; hidden on its own so it is not read twice.
          <View
            style={styles.badge}
            importantForAccessibility="no-hide-descendants"
            accessibilityElementsHidden
            testID="quick-inbox-badge"
          >
            <Text style={styles.badgeText}>{badge}</Text>
          </View>
        ) : null}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingRight: spacing.lg,
  },
  pass: {
    minHeight: MIN_TOUCH_SIZE,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    backgroundColor: colors.night,
  },
  passText: { ...fonts.extrabold, fontSize: 14, lineHeight: 18, color: colors.floodlight },
  inbox: {
    width: MIN_TOUCH_SIZE,
    height: MIN_TOUCH_SIZE,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.background,
    borderWidth: 1,
    borderColor: colors.border,
  },
  badge: {
    position: 'absolute',
    top: -2,
    right: -4,
    minWidth: 20,
    paddingHorizontal: 5,
    borderRadius: radius.pill,
    backgroundColor: colors.danger,
    borderWidth: 2,
    borderColor: colors.page,
    alignItems: 'center',
  },
  badgeText: { ...fonts.extrabold, fontSize: 11, lineHeight: 14, color: colors.primaryText },
  pressed: { opacity: 0.8 },
});
