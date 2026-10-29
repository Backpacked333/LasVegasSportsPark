/**
 * SCR-C-06 Notification inbox (SPK-UX-002, SPK-COMMS-001, SPK-COMMS-004, SPK-COMMS-005,
 * SPK-COMMS-007, SPK-IAM-006, SPK-AT-017, SPK-UX-008, SPK-UX-009). Reachable from Home and every
 * destination header, not a tab.
 *
 * - `GET /v1/me/inbox` lists the person's in-app notices, newest first. The API re-checks each
 *   protected notice on every read and leaves out any the person may no longer see (a grant was
 *   removed, SPK-IAM-006, SPK-AT-017), so such a notice simply disappears on the next refresh.
 * - Opening a notice marks it read (`POST /v1/me/inbox/{id}/read`); "Acknowledge" records it once
 *   (`POST /v1/me/inbox/{id}/acknowledge`). Both are idempotent commands with one key per intent
 *   and send the delivery attempt's `revision` as `expectedRevision` (§4.9): the newest the screen
 *   knows (the list's, or the one the read returned). STALE_REVISION (read or acknowledged
 *   elsewhere meanwhile) reloads the list; acknowledging shows the code with "Reload".
 *   If the API answers NOT_FOUND the notice was withdrawn: the screen says it is no longer
 *   available and refreshes the list, without implying anything about it.
 * - Each notice names the participants it concerns (`subjectPersonIds`, SPK-UX-003): "For: You,
 *   Sam", names from `GET /v1/person-names` (given names only, §4.14).
 * - A notice replaced by a newer one says "Replaced by a newer update" and links to the newer
 *   notice, so an opened old notice never passes for the current state (§6.2 "Notification opened
 *   after its event changes"). Schedule notices show old and new details (SPK-COMMS-005).
 * - Essential notices and promotional messages are labelled apart (SPK-COMMS-007).
 * - Offline: the cached list with its age; reading and acknowledging wait for a connection.
 *
 * Status vocabulary (journeys.md section 3): "Unread", "Read", "Acknowledged",
 * "Replaced by a newer update".
 */
import type { Schema } from '@sportspark/api-client';
import { useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter, type Href } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { ChangeDetails } from '../../features/today/ChangeDetails';
import { categoryLabel, scheduleChangeOf } from '../../features/today/notices';
import {
  INBOX_PAGE_SIZE,
  nameOf,
  useApiReads,
  useMe,
  usePersonNames,
} from '../../features/today/queries';
import { Caption, SectionQueryState } from '../../features/today/Section';
import { noticeStatus } from '../../features/today/status';
import { displayZone, formatWhen } from '../../features/today/time';
import { useApp, useConnectivity } from '../../providers/AppProviders';
import { RequireSession } from '../../session/RequireSession';
import { Button } from '../../ui/Button';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { Screen } from '../../ui/Screen';
import { StateView } from '../../ui/StateView';
import { StatusBadge, type StatusBadgeProps } from '../../ui/StatusBadge';
import { colors, MIN_TOUCH_SIZE, spacing, type } from '../../ui/theme';

type InboxItem = Schema<'InboxItem'>;
type InboxPage = Schema<'InboxPage'>;

/** Kept for existing callers; the vocabulary lives in features/today/status. */
export function inboxStatus(item: InboxItem): StatusBadgeProps {
  return noticeStatus(item);
}

const INBOX_KEY = ['api', '/me/inbox'] as const;

/** "For: You, Sam" for a notice about named participants; empty when it names none. */
export function participantsLine(item: InboxItem, names: Map<string, string>): string {
  const ids = item.subjectPersonIds ?? [];
  return ids.length > 0 ? `For: ${ids.map((id) => nameOf(names, id)).join(', ')}` : '';
}

/** The body of a read or acknowledge: the newest revision known, when the API gave one. */
function revisionBody(...revisions: (number | null | undefined)[]): { expectedRevision?: number } {
  const known = revisions.filter((r): r is number => typeof r === 'number');
  return known.length > 0 ? { expectedRevision: Math.max(...known) } : {};
}

function NoticeDetail({
  item,
  newer,
  onShowNewer,
}: {
  item: InboxItem;
  newer: InboxItem | null;
  onShowNewer: (attemptId: string) => void;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { reachable } = useConnectivity();
  const offline = reachable === false;
  const read = useApiCommand('post', '/me/inbox/{id}/read', { invalidate: [INBOX_KEY] });
  const acknowledge = useApiCommand('post', '/me/inbox/{id}/acknowledge', {
    invalidate: [INBOX_KEY],
  });
  const sentRead = useRef(false);
  const withdrawn =
    read.error?.isNotFound === true ||
    acknowledge.error?.isNotFound === true ||
    acknowledge.error?.isPermissionRestriction === true;

  // Opening an unread notice marks it read, once per opening; failures are not shown (the
  // notice stays "Unread") except a withdrawn notice, which is handled below.
  useEffect(() => {
    if (sentRead.current || item.readAt || item.acknowledgedAt || offline) return;
    sentRead.current = true;
    read
      .submit({ path: { id: item.attemptId }, body: revisionBody(item.revision) })
      .catch(() => undefined);
  }, [item.attemptId, item.readAt, item.acknowledgedAt, item.revision, offline, read]);

  // A notice the API no longer serves (SPK-IAM-006) leaves the list on refresh; one changed
  // elsewhere (STALE_REVISION: read on another device) is read again to show its state.
  const readStale = read.error?.code === 'STALE_REVISION';
  useEffect(() => {
    if (withdrawn || readStale) void queryClient.invalidateQueries({ queryKey: INBOX_KEY });
  }, [withdrawn, readStale, queryClient]);

  const acknowledgeNow = () =>
    void acknowledge
      .submit({
        path: { id: item.attemptId },
        body: revisionBody(item.revision, read.data?.revision),
      })
      .catch(() => undefined);
  const reload = () => {
    acknowledge.reset();
    void queryClient.invalidateQueries({ queryKey: INBOX_KEY });
  };

  if (withdrawn) {
    return (
      <StateView
        variant="unavailable"
        title="No longer available"
        description="This notice is no longer available to you."
      />
    );
  }

  const change = scheduleChangeOf(item);
  const zone = displayZone(change?.after?.timezone ?? change?.before?.timezone ?? null);
  const fixtureId = item.subject?.type === 'fixture' ? item.subject.id : null;
  const canAcknowledge = !item.acknowledgedAt && !item.supersededByNotificationId;

  return (
    <View style={styles.detail} testID={`notice-detail-${item.attemptId}`}>
      <Text style={styles.caption}>
        {categoryLabel(item)}
        {item.deliveredAt ? `. Received ${formatWhen(item.deliveredAt, zone.zone)}` : ''}
      </Text>
      <Text style={styles.body}>{item.body}</Text>
      {change ? <ChangeDetails change={change} testID={`notice-change-${item.attemptId}`} /> : null}
      {item.supersededByNotificationId ? (
        <View style={styles.gap}>
          <Text style={styles.body}>A newer update replaces this notice.</Text>
          {newer ? (
            <Button
              label="Show the newer update"
              variant="secondary"
              onPress={() => onShowNewer(newer.attemptId)}
              testID={`notice-newer-${item.attemptId}`}
            />
          ) : (
            <Text style={styles.caption}>The newer update is not available to you.</Text>
          )}
        </View>
      ) : null}
      {fixtureId ? (
        <Button
          label="Open fixture"
          variant="secondary"
          onPress={() =>
            router.push({ pathname: '/fixtures/[id]', params: { id: fixtureId } } as Href)
          }
        />
      ) : null}
      {canAcknowledge ? (
        <Button
          label="Acknowledge"
          busy={acknowledge.isProcessing}
          disabled={offline}
          accessibilityHint="Records that you have seen this notice"
          onPress={acknowledgeNow}
          testID={`notice-ack-${item.attemptId}`}
        />
      ) : null}
      {offline && canAcknowledge ? (
        <Text style={styles.caption}>Acknowledging needs a connection.</Text>
      ) : null}
      {acknowledge.error && !withdrawn ? (
        <StateView
          variant="error"
          error={acknowledge.error}
          onRetry={acknowledgeNow}
          onAction={acknowledge.error.isStale ? reload : undefined}
        />
      ) : null}
      {acknowledge.status === 'success' ? (
        <View accessibilityLiveRegion="polite">
          <StatusBadge tone="success" label="Acknowledged" />
        </View>
      ) : null}
    </View>
  );
}

function NoticeRow({
  item,
  expanded,
  newer,
  names,
  onToggle,
  onShowNewer,
}: {
  item: InboxItem;
  expanded: boolean;
  newer: InboxItem | null;
  names: Map<string, string>;
  onToggle: () => void;
  onShowNewer: (attemptId: string) => void;
}) {
  const status = noticeStatus(item);
  const about = participantsLine(item, names);
  return (
    <View style={styles.row} testID={`inbox-item-${item.attemptId}`}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={[item.title, about, status.label].filter(Boolean).join(', ')}
        accessibilityHint={expanded ? 'Hides the notice' : 'Shows the whole notice'}
        accessibilityState={{ expanded }}
        onPress={onToggle}
        style={({ pressed }) => [styles.header, pressed && styles.pressed]}
        testID={`inbox-toggle-${item.attemptId}`}
      >
        <Text style={styles.title}>{item.title}</Text>
        {about ? <Text style={styles.caption}>{about}</Text> : null}
        {!expanded ? (
          <Text style={styles.caption} numberOfLines={2}>
            {item.body}
          </Text>
        ) : null}
        <StatusBadge {...status} />
      </Pressable>
      {expanded ? <NoticeDetail item={item} newer={newer} onShowNewer={onShowNewer} /> : null}
    </View>
  );
}

function InboxList({ openId }: { openId?: string }) {
  const { session } = useApp();
  const signedIn = session.status === 'signed_in';
  const first = useApiQuery({
    path: '/me/inbox',
    request: { query: { limit: INBOX_PAGE_SIZE } },
    enabled: signedIn,
  });
  const [cursors, setCursors] = useState<string[]>([]);
  const older = useApiReads(
    '/me/inbox',
    useMemo(
      () => cursors.map((cursor) => ({ query: { limit: INBOX_PAGE_SIZE, cursor } })),
      [cursors],
    ),
    signedIn,
  );
  const me = useMe();
  const loadedItems = [first.data, ...older.map((o) => o.data)].flatMap((p) => p?.items ?? []);
  const names = usePersonNames(
    loadedItems.flatMap((i) => i.subjectPersonIds ?? []),
    me.data,
  );
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(openId ? [openId] : []));
  useEffect(() => {
    if (openId) setExpanded((s) => new Set(s).add(openId));
  }, [openId]);

  const toggle = (id: string) =>
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <QueryBoundary
      query={first}
      label="notifications"
      isEmpty={(page) => page.items.length === 0}
      empty={{
        title: 'No notifications',
        description: 'Schedule changes, results and messages from the facility will appear here.',
      }}
      unavailableOffline={['marking notices as read', 'acknowledging notices']}
    >
      {(page) => {
        const pages: InboxPage[] = [page, ...older.flatMap((o) => (o.data ? [o.data] : []))];
        const items = pages.flatMap((p) => p.items);
        const byNotification = new Map(items.map((i) => [i.notificationId, i]));
        const last = pages[pages.length - 1];
        const pendingOlder = older.find((o) => o.data === undefined);
        return (
          <View>
            <View accessibilityRole="list">
              {items.map((item) => (
                <NoticeRow
                  key={item.attemptId}
                  item={item}
                  expanded={expanded.has(item.attemptId)}
                  newer={
                    item.supersededByNotificationId
                      ? (byNotification.get(item.supersededByNotificationId) ?? null)
                      : null
                  }
                  names={names}
                  onToggle={() => toggle(item.attemptId)}
                  onShowNewer={(id) => setExpanded((s) => new Set(s).add(id))}
                />
              ))}
            </View>
            {pendingOlder ? (
              <SectionQueryState read={pendingOlder} label="older notices" />
            ) : last?.nextCursor ? (
              <View style={styles.more}>
                <Button
                  label="Show older notices"
                  variant="secondary"
                  onPress={() => {
                    const cursor = last.nextCursor;
                    if (cursor) setCursors((c) => (c.includes(cursor) ? c : [...c, cursor]));
                  }}
                  testID="inbox-older"
                />
              </View>
            ) : null}
            <Caption>
              Notices you can no longer see, for example after a permission was removed, are not
              listed.
            </Caption>
          </View>
        );
      }}
    </QueryBoundary>
  );
}

export function InboxScreen({ openId }: { openId?: string } = {}) {
  return (
    <Screen>
      <RequireSession what="your notifications">
        <InboxList openId={openId} />
      </RequireSession>
    </Screen>
  );
}

/** Route entry: `/inbox?open=<attemptId>` opens one notice (links from Home). */
export function InboxRoute() {
  const { open } = useLocalSearchParams<{ open?: string }>();
  return <InboxScreen openId={typeof open === 'string' ? open : undefined} />;
}

const styles = StyleSheet.create({
  row: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    backgroundColor: colors.background,
  },
  header: {
    minHeight: MIN_TOUCH_SIZE,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    gap: spacing.xs,
  },
  pressed: { backgroundColor: colors.surface },
  title: { ...type.body, fontWeight: '600', color: colors.text },
  body: { ...type.body, color: colors.text },
  caption: { ...type.caption, color: colors.textMuted },
  detail: { paddingHorizontal: spacing.lg, paddingBottom: spacing.lg, gap: spacing.sm },
  gap: { gap: spacing.sm },
  more: { padding: spacing.lg },
});
