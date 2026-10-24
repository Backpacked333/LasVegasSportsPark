/**
 * SCR-C-06 Notification inbox (SPK-UX-002, SPK-COMMS-004, SPK-COMMS-005): reachable from Home and
 * every destination header, not a tab. This foundation version reads `GET /v1/me/inbox` and shows
 * the loading, empty, error, offline/stale and unavailable states; marking read and acknowledging
 * (`POST /v1/me/inbox/{id}/read`, `/acknowledge`) belong to the communications screen group.
 *
 * Status vocabulary from docs/package-a/journeys.md section 3: "Unread", "Read", "Acknowledged";
 * a superseded notice reads "Replaced by a newer update".
 */
import type { Schema } from '@sportspark/api-client';
import { View } from 'react-native';
import { useApiQuery } from '../../api/useApiQuery';
import { useApp } from '../../providers/AppProviders';
import { RequireSession } from '../../session/RequireSession';
import { ListRow } from '../../ui/ListRow';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { Screen } from '../../ui/Screen';
import type { StatusBadgeProps } from '../../ui/StatusBadge';

type InboxItem = Schema<'InboxItem'>;

export function inboxStatus(item: InboxItem): StatusBadgeProps {
  if (item.supersededByNotificationId) {
    return { tone: 'neutral', label: 'Replaced by a newer update' };
  }
  if (item.acknowledgedAt) return { tone: 'success', label: 'Acknowledged' };
  if (item.readAt) return { tone: 'neutral', label: 'Read' };
  return { tone: 'info', label: 'Unread' };
}

function InboxList() {
  const { session } = useApp();
  const inbox = useApiQuery({
    path: '/me/inbox',
    request: { query: { limit: 50 } },
    enabled: session.status === 'signed_in',
  });
  return (
    <QueryBoundary
      query={inbox}
      label="notifications"
      isEmpty={(page) => page.items.length === 0}
      empty={{
        title: 'No notifications',
        description: 'Schedule changes, results and messages from the facility will appear here.',
      }}
      unavailableOffline={['marking notices as read', 'acknowledging notices']}
    >
      {(page) => (
        <View accessibilityRole="list">
          {page.items.map((item) => (
            <ListRow
              key={item.attemptId}
              title={item.title}
              detail={item.body}
              status={inboxStatus(item)}
              testID={`inbox-item-${item.attemptId}`}
            />
          ))}
        </View>
      )}
    </QueryBoundary>
  );
}

export function InboxScreen() {
  return (
    <Screen>
      <RequireSession what="your notifications">
        <InboxList />
      </RequireSession>
    </Screen>
  );
}
