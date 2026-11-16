/**
 * The actions in the header of every destination (SPK-UX-002, PA-11 **Proposed**): the facility
 * pass (SCR-C-05) and the notification inbox (SCR-C-06) without a permanent tab, and, while a
 * registration is in progress, the cart (SCR-C-11), so a started registration is reachable from
 * every destination until it is checked out or abandoned. Icon buttons (`ui/IconButton`): the
 * words, not the icons, name each one to screen readers (SPK-UX-009).
 *
 * - **Cart**: shown only while the newest page of the caller's baskets (`GET /v1/me/baskets`, the
 *   same read Explore's "In progress" uses) has one in progress (`basketInProgress`: open with
 *   lines, held, or checking out). It opens that basket. While the list is loading, failed or
 *   signed out there is no button, never a guess.
 * - **Facility pass**: opens the pass.
 * - **Notification inbox**: carries the unread count (`GET /v1/me/inbox/unread-count`,
 *   SPK-UX-003) in its accessible name ("Notification inbox, 3 unread") and as a badge. While the
 *   count is loading, failed or zero there is no badge and the plain name. Past the API's cap the
 *   name says "more than 99" and the badge "99+", as `inboxButtonLabel` and `unreadBadgeText` say.
 */
import { useRouter } from 'expo-router';
import { Text, View } from 'react-native';
import { inboxButtonLabel, unreadBadgeText, useInboxUnreadCount } from '../api/inbox-unread';
import { basketInProgress, useMyBaskets } from '../features/registration/in-progress';
import { registrationRoutes } from '../features/registration/routes';
import { IconButton } from '../ui/IconButton';
import { makeStyles, spacing, tabularFigures, type } from '../ui/theme';

/** The newest basket still in progress, or null (none, or the list is not known). */
function useCartInProgress(): string | null {
  const baskets = useMyBaskets();
  return baskets.data?.items.find(basketInProgress)?.id ?? null;
}

function InboxButton() {
  const router = useRouter();
  const styles = useStyles();
  const unread = useInboxUnreadCount();
  const open = () => router.push('/inbox');
  const data = unread.data;
  if (!data?.capped) {
    // The count goes through the button itself: name "Notification inbox, 3 unread" and badge.
    return (
      <IconButton
        icon="notifications"
        label="Notification inbox"
        count={data?.unread}
        countLabel="unread"
        onPress={open}
        testID="quick-inbox"
      />
    );
  }
  // Past the cap the exact number is not known: the name says "more than <cap>" and the badge
  // "<cap>+", drawn in the same place and tokens as the button's own badge.
  return (
    <View>
      <IconButton
        icon="notifications"
        label={inboxButtonLabel(data)}
        onPress={open}
        testID="quick-inbox"
      />
      <View
        pointerEvents="none"
        style={styles.badge}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        testID="quick-inbox-badge"
      >
        <Text style={styles.badgeText} maxFontSizeMultiplier={1.3}>
          {unreadBadgeText(data)}
        </Text>
      </View>
    </View>
  );
}

export function HeaderActions() {
  const router = useRouter();
  const styles = useStyles();
  const cart = useCartInProgress();
  return (
    <View style={styles.row}>
      {cart ? (
        <IconButton
          icon="shopping_cart"
          label="Cart"
          accessibilityHint="Continues the registration you started"
          onPress={() => router.push(registrationRoutes.basket(cart))}
          testID="header-cart"
        />
      ) : null}
      <IconButton
        icon="qr_code_2"
        label="Facility pass"
        variant="tonal"
        onPress={() => router.push('/pass')}
        testID="quick-pass"
      />
      <InboxButton />
    </View>
  );
}

const BADGE_SIZE = 18;

const useStyles = makeStyles(({ colors }) => ({
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  badge: {
    position: 'absolute',
    top: spacing.xxs,
    right: spacing.xxs,
    minWidth: BADGE_SIZE,
    minHeight: BADGE_SIZE,
    paddingHorizontal: spacing.xs,
    borderRadius: BADGE_SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.countBadge,
  },
  badgeText: {
    ...type.micro,
    fontSize: 11,
    lineHeight: 14,
    ...tabularFigures,
    color: colors.onCountBadge,
  },
}));
