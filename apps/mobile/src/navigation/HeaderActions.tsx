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
 *   name says "more than 99" and the badge "99+" (`IconButton` `countCapped`), the same words as
 *   `inboxButtonLabel` and `unreadBadgeText`.
 */
import { useRouter } from 'expo-router';
import { View } from 'react-native';
import { useInboxUnreadCount } from '../api/inbox-unread';
import { basketInProgress, useMyBaskets } from '../features/registration/in-progress';
import { registrationRoutes } from '../features/registration/routes';
import { IconButton } from '../ui/IconButton';
import { makeStyles, spacing } from '../ui/theme';

/** The newest basket still in progress, or null (none, or the list is not known). */
function useCartInProgress(): string | null {
  const baskets = useMyBaskets();
  return baskets.data?.items.find(basketInProgress)?.id ?? null;
}

function InboxButton() {
  const router = useRouter();
  const unread = useInboxUnreadCount();
  const data = unread.data;
  // Name "Notification inbox, 3 unread" and the badge; past the API's cap the button says "more
  // than <cap>" and "<cap>+" (`countCapped`), as `inboxButtonLabel` and `unreadBadgeText` do.
  return (
    <IconButton
      icon="notifications"
      label="Notification inbox"
      count={data && data.unread > 0 ? (data.capped ? data.cap : data.unread) : undefined}
      countLabel="unread"
      countCapped={data?.capped === true}
      onPress={() => router.push('/inbox')}
      testID="quick-inbox"
    />
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

const useStyles = makeStyles(() => ({
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
}));
