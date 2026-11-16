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
 *   knows (the list's, or the one the read returned). A notice already read or acknowledged
 *   elsewhere answers its current state (§4.9); any STALE_REVISION still reloads the list, and
 *   acknowledging shows the code with "Reload". An
 *   acknowledgement with no definite answer (`mayHaveTakenEffect`) reads "No answer yet" with
 *   "Check again" under the same key, never "Something went wrong" (the shared account
 *   `CommandError`).
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
 * - Look and finding things (ADR-008, PA-11): "All" and "Needs action" tabs (`SegmentedControl`;
 *   "Needs action" is `needsAction`, inbox-sections.ts) over a list in sections by day ("Today",
 *   "Yesterday", "Sat, Oct 24"), with pull to refresh. A row opens its item (`noticeTarget`, as on
 *   Home): the record the notice is about, marked read with the same request the notice sends when
 *   opened, or else the notice itself in a sheet with "Acknowledge". The empty inbox is the
 *   `empty-inbox` illustration. A notice the API withdrew while open says so in its sheet.
 *
 * Status vocabulary (journeys.md section 3): "Unread", "Read", "Acknowledged",
 * "Replaced by a newer update".
 */
import type { Schema } from '@sportspark/api-client';
import { presentationForError } from '@sportspark/api-client';
import { useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter, type Href } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { Pressable, View } from 'react-native';
import { illustrations } from '../../artwork/manifest';
import { UNREAD_COUNT_KEY } from '../../api/inbox-unread';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { ChangeDetails } from '../../features/today/ChangeDetails';
import { noticeTarget } from '../../features/today/notice-target';
import {
  availabilityRequestOf,
  categoryLabel,
  scheduleChangeOf,
} from '../../features/today/notices';
import {
  INBOX_PAGE_SIZE,
  nameOf,
  useApiReads,
  useMe,
  usePersonNames,
} from '../../features/today/queries';
import { SectionQueryState } from '../../features/today/Section';
import { noticeStatus } from '../../features/today/status';
import { displayZone, formatTime, formatWhen } from '../../features/today/time';
import { useApp, useConnectivity, useNow } from '../../providers/AppProviders';
import { RequireSession } from '../../session/RequireSession';
import { LiveRegion, sentences } from '../../ui/announce';
import { Button } from '../../ui/Button';
import { EmptyState } from '../../ui/EmptyState';
import { Icon } from '../../ui/Icon';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { Screen } from '../../ui/Screen';
import { SegmentedControl } from '../../ui/SegmentedControl';
import { Sheet } from '../../ui/Sheet';
import { StateView } from '../../ui/StateView';
import { StatusBadge, type StatusBadgeProps } from '../../ui/StatusBadge';
import { Text } from '../../ui/Text';
import {
  continuousCorners,
  layout,
  makeStyles,
  MIN_TOUCH_SIZE,
  radius,
  spacing,
  useTheme,
} from '../../ui/theme';
import { CommandError } from '../account/components/CommandError';
import { inboxSections, noticeTime, type InboxDay, type InboxTab } from './inbox-sections';

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

/** The customer word for what a notice is about, on its "Open …" button (PA-11). */
const SUBJECT_WORDS: Readonly<Record<string, string>> = {
  fixture: 'Open the game',
  enrollment: 'Open the registration',
  obligation: 'Open the payment',
  payment_attempt: 'Open the payment',
  order: 'Open the order',
  waitlist_entry: 'Open your waitlist place',
  team_entry: 'Open the team',
  contribution_request: 'Open your share',
  booking: 'Open the booking',
  offering: 'Open the activity',
};

/** The label of the button that opens what a notice is about ("Open the game"). */
export function openSubjectLabel(item: InboxItem): string {
  const type = availabilityRequestOf(item) ? 'fixture' : (item.subject?.type ?? '');
  return SUBJECT_WORDS[type] ?? 'Open';
}

function NoticeDetail({
  item,
  newer,
  onShowNewer,
  onWithdrawn,
}: {
  item: InboxItem;
  newer: InboxItem | null;
  onShowNewer: (attemptId: string) => void;
  onWithdrawn: (attemptId: string) => void;
}) {
  const styles = useStyles();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { reachable } = useConnectivity();
  const offline = reachable === false;
  // The header badge (UNREAD_COUNT_KEY) is read again with the list (SPK-UX-003).
  const read = useApiCommand('post', '/me/inbox/{id}/read', {
    invalidate: [INBOX_KEY, UNREAD_COUNT_KEY],
  });
  const acknowledge = useApiCommand('post', '/me/inbox/{id}/acknowledge', {
    invalidate: [INBOX_KEY, UNREAD_COUNT_KEY],
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
    if (withdrawn) onWithdrawn(item.attemptId);
    if (withdrawn || readStale) void queryClient.invalidateQueries({ queryKey: INBOX_KEY });
  }, [withdrawn, readStale, queryClient, onWithdrawn, item.attemptId]);

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

  if (withdrawn) return <NoticeWithdrawn />;

  const change = scheduleChangeOf(item);
  const zone = displayZone(change?.after?.timezone ?? change?.before?.timezone ?? null);
  const target = noticeTarget(item);
  const canAcknowledge = !item.acknowledgedAt && !item.supersededByNotificationId;

  return (
    <View style={styles.detail} testID={`notice-detail-${item.attemptId}`}>
      {/* After "Acknowledge" the announced badge below says it; the status is not shown twice. */}
      {acknowledge.status !== 'success' ? <StatusBadge {...noticeStatus(item)} /> : null}
      <Text variant="footnote" tone="muted">
        {categoryLabel(item)}
        {item.deliveredAt ? `. Received ${formatWhen(item.deliveredAt, zone.zone)}` : ''}
      </Text>
      <Text variant="body">{item.body}</Text>
      {change ? <ChangeDetails change={change} testID={`notice-change-${item.attemptId}`} /> : null}
      {item.supersededByNotificationId ? (
        <View style={styles.gap}>
          <Text variant="body">A newer update replaces this notice.</Text>
          {newer ? (
            <Button
              label="Show the newer update"
              variant="secondary"
              onPress={() => onShowNewer(newer.attemptId)}
              testID={`notice-newer-${item.attemptId}`}
            />
          ) : (
            <Text variant="footnote" tone="muted">
              The newer update is not available to you.
            </Text>
          )}
        </View>
      ) : null}
      {target.kind === 'subject' ? (
        <Button
          label={openSubjectLabel(item)}
          variant="secondary"
          onPress={() => router.push(target.href as Href)}
        />
      ) : null}
      {canAcknowledge ? (
        // Waits for the read just sent: it bumps the revision, so acknowledging now would send
        // the old one and answer STALE_REVISION (§4.9).
        <Button
          label="Acknowledge"
          busy={acknowledge.isProcessing || read.isProcessing}
          disabled={offline || read.isProcessing}
          accessibilityHint="Records that you have seen this notice"
          onPress={acknowledgeNow}
          testID={`notice-ack-${item.attemptId}`}
        />
      ) : null}
      {offline && canAcknowledge ? (
        <Text variant="footnote" tone="muted">
          Acknowledging needs a connection.
        </Text>
      ) : null}
      {acknowledge.error && !withdrawn ? (
        <CommandError error={acknowledge.error} onRetry={acknowledgeNow} onReload={reload} />
      ) : null}
      {acknowledge.status === 'success' ? (
        <LiveRegion announcement="Acknowledged">
          <StatusBadge tone="success" label="Acknowledged" />
        </LiveRegion>
      ) : null}
    </View>
  );
}

/** A notice the API no longer serves to this person: nothing about it is implied (§4.10). */
function NoticeWithdrawn() {
  return (
    <StateView
      variant="unavailable"
      title="No longer available"
      description="This notice is no longer available to you."
    />
  );
}

/**
 * One notice in the list: a button named "title, for whom, status", that opens its item. Opening
 * the record a notice is about marks an unread notice read with the request the notice sends when
 * opened (SPK-COMMS-004); not while offline.
 */
function NoticeRow({
  item,
  names,
  zone,
  onOpenNotice,
}: {
  item: InboxItem;
  names: Map<string, string>;
  zone: string;
  onOpenNotice: (attemptId: string, trigger: RefObject<View | null>) => void;
}) {
  const styles = useStyles();
  const { colors } = useTheme();
  const router = useRouter();
  const { reachable } = useConnectivity();
  const ref = useRef<View>(null);
  const read = useApiCommand('post', '/me/inbox/{id}/read', {
    invalidate: [INBOX_KEY, UNREAD_COUNT_KEY],
  });
  const status = noticeStatus(item);
  const about = participantsLine(item, names);
  const unread = !item.readAt && !item.acknowledgedAt;
  const target = noticeTarget(item);
  const open = () => {
    if (target.kind !== 'subject') {
      onOpenNotice(item.attemptId, ref);
      return;
    }
    router.push(target.href as Href);
    if (!unread || reachable === false) return;
    read
      .submit({ path: { id: item.attemptId }, body: revisionBody(item.revision) })
      .catch(() => undefined);
  };
  return (
    <Pressable
      ref={ref}
      accessibilityRole="button"
      accessibilityLabel={[item.title, about, status.label].filter(Boolean).join(', ')}
      accessibilityHint={
        target.kind === 'subject' ? 'Opens what this notice is about' : 'Opens the notice'
      }
      onPress={open}
      android_ripple={{ color: colors.surface }}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
      testID={`inbox-item-${item.attemptId}`}
    >
      <View style={[styles.dot, unread ? styles.dotUnread : null]} />
      <View style={styles.rowText}>
        <View style={styles.rowTop}>
          <Text variant="headline" style={styles.rowTitle}>
            {item.title}
          </Text>
          <Text variant="footnote" tone="muted" tabular>
            {formatTime(noticeTime(item), zone)}
          </Text>
        </View>
        {about ? (
          <Text variant="footnote" tone="muted">
            {about}
          </Text>
        ) : null}
        <Text variant="callout" tone="muted" numberOfLines={2}>
          {item.body}
        </Text>
        <StatusBadge {...status} />
      </View>
      <Icon name="chevron_right" size={22} color={colors.primary} />
    </Pressable>
  );
}

const TABS = [
  { value: 'all', label: 'All' },
  { value: 'action', label: 'Needs action' },
] as const;

const EMPTY_TITLE = 'No notifications';
const EMPTY_TEXT = 'Schedule changes, results and messages from the facility will appear here.';

function InboxList({ openId }: { openId?: string }) {
  const styles = useStyles();
  const now = useNow();
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
  const pages: InboxPage[] = first.data
    ? [first.data, ...older.flatMap((o) => (o.data ? [o.data] : []))]
    : [];
  const items = pages.flatMap((p) => p.items);
  const names = usePersonNames(
    items.flatMap((i) => i.subjectPersonIds ?? []),
    me.data,
  );
  const [tab, setTab] = useState<InboxTab>('all');
  const [open, setOpen] = useState<string | null>(openId ?? null);
  const [withdrawn, setWithdrawn] = useState<ReadonlySet<string>>(() => new Set());
  const returnFocus = useRef<unknown>(null);
  useEffect(() => {
    if (openId) setOpen(openId);
  }, [openId]);

  const onWithdrawn = useCallback(
    (id: string) => setWithdrawn((s) => (s.has(id) ? s : new Set(s).add(id))),
    [],
  );
  const openNotice = useCallback((id: string, from: RefObject<View | null>) => {
    returnFocus.current = from.current;
    setOpen(id);
  }, []);

  const [refreshing, setRefreshing] = useState(false);
  const refresh = async () => {
    setRefreshing(true);
    try {
      await Promise.all([first.refetch(), ...older.map((o) => o.refetch())]);
    } finally {
      setRefreshing(false);
    }
  };

  const zone = displayZone(null).zone;
  // Cached notices are not listed once the API answers that the list is not available (§4.10).
  const listed =
    first.data !== undefined &&
    !(first.error && presentationForError(first.error) === 'unavailable');
  const sections: InboxDay[] = listed ? inboxSections(items, tab, now, zone) : [];
  const byNotification = new Map(items.map((i) => [i.notificationId, i]));
  const byAttempt = new Map(items.map((i) => [i.attemptId, i]));
  const openItem = open ? (byAttempt.get(open) ?? null) : null;
  const openWithdrawn = open !== null && openItem === null && withdrawn.has(open);
  const last = pages[pages.length - 1];
  const pendingOlder = older.find((o) => o.data === undefined);

  const footer = listed ? (
    <View style={styles.footer}>
      {pendingOlder ? (
        <SectionQueryState read={pendingOlder} label="older notices" />
      ) : last?.nextCursor ? (
        <Button
          label="Show older notices"
          variant="secondary"
          onPress={() => {
            const cursor = last.nextCursor;
            if (cursor) setCursors((c) => (c.includes(cursor) ? c : [...c, cursor]));
          }}
          testID="inbox-older"
        />
      ) : null}
      {items.length > 0 ? (
        <Text variant="footnote" tone="muted">
          Notices you can no longer see, for example after a permission was removed, are not listed.
        </Text>
      ) : null}
    </View>
  ) : null;

  return (
    <Screen<InboxItem, InboxDay>
      onRefresh={() => void refresh()}
      refreshing={refreshing}
      sections={{
        sections,
        keyExtractor: (item) => item.attemptId,
        renderSectionHeader: ({ section }) => (
          <Text variant="label" tone="muted" heading style={styles.day}>
            {section.title}
          </Text>
        ),
        renderItem: ({ item }) => (
          <NoticeRow item={item} names={names} zone={zone} onOpenNotice={openNotice} />
        ),
        ItemSeparatorComponent: () => <View style={styles.separator} />,
        ListEmptyComponent:
          listed && items.length > 0 ? (
            <EmptyState
              title="You're all caught up"
              message="Nothing in your notifications needs you right now."
              testID="inbox-no-action"
            />
          ) : null,
        ListFooterComponent: footer,
        stickySectionHeadersEnabled: false,
      }}
    >
      <QueryBoundary
        query={first}
        label="notifications"
        empty={{ title: EMPTY_TITLE, description: EMPTY_TEXT }}
        unavailableOffline={['marking notices as read', 'acknowledging notices']}
      >
        {(page) =>
          page.items.length === 0 && items.length === 0 ? (
            <LiveRegion announcement={sentences(EMPTY_TITLE, EMPTY_TEXT)}>
              <EmptyState
                source={illustrations['empty-inbox']}
                title={EMPTY_TITLE}
                message={EMPTY_TEXT}
                testID="inbox-empty"
              />
            </LiveRegion>
          ) : (
            <SegmentedControl<InboxTab>
              label="Show"
              segments={TABS}
              value={tab}
              onChange={setTab}
              style={styles.tabs}
              testID="inbox-tabs"
            />
          )
        }
      </QueryBoundary>
      <Sheet
        open={openItem !== null || openWithdrawn}
        onClose={() => setOpen(null)}
        title={openItem?.title ?? 'Notice'}
        returnFocusTo={returnFocus}
      >
        {openItem ? (
          <NoticeDetail
            key={openItem.attemptId}
            item={openItem}
            newer={
              openItem.supersededByNotificationId
                ? (byNotification.get(openItem.supersededByNotificationId) ?? null)
                : null
            }
            onShowNewer={setOpen}
            onWithdrawn={onWithdrawn}
          />
        ) : openWithdrawn ? (
          <NoticeWithdrawn />
        ) : null}
      </Sheet>
    </Screen>
  );
}

export function InboxScreen({ openId }: { openId?: string } = {}) {
  const { session } = useApp();
  // Signed in: the inbox draws its own list frame, with pull to refresh.
  if (session.status === 'signed_in') return <InboxList openId={openId} />;
  return (
    <Screen>
      <RequireSession what="your notifications">{null}</RequireSession>
    </Screen>
  );
}

/** Route entry: `/inbox?open=<attemptId>` opens one notice (links from Home). */
export function InboxRoute() {
  const { open } = useLocalSearchParams<{ open?: string }>();
  return <InboxScreen openId={typeof open === 'string' ? open : undefined} />;
}

const useStyles = makeStyles(({ colors }) => ({
  tabs: { marginHorizontal: layout.gutter, marginTop: spacing.md },
  day: { paddingHorizontal: layout.gutter, paddingTop: spacing.xl, paddingBottom: spacing.sm },
  row: {
    minHeight: MIN_TOUCH_SIZE,
    marginHorizontal: layout.gutter,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.lg,
    ...continuousCorners,
    backgroundColor: colors.background,
    borderWidth: 1,
    borderColor: colors.border,
  },
  pressed: { backgroundColor: colors.surface },
  separator: { height: spacing.sm },
  // The unread dot is decorative: the status badge says "Unread" in words.
  dot: { width: 8, height: 8, marginTop: 8, borderRadius: radius.pill },
  dotUnread: { backgroundColor: colors.primary },
  rowText: { flex: 1, gap: spacing.xs },
  rowTop: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  rowTitle: { flex: 1 },
  detail: { gap: spacing.sm },
  gap: { gap: spacing.sm },
  footer: { paddingHorizontal: layout.gutter, paddingVertical: spacing.lg, gap: spacing.md },
}));
