/**
 * SCR-C-03 Home (SPK-UX-002, SPK-UX-003, SPK-UX-004, SPK-COMMS-005, SPK-UX-008, SPK-UX-009).
 *
 * Order (SPK-UX-003): a registration whose payment was received but not completed is pinned above
 * everything (§4.11 recovery); then urgent changes, the next scheduled activity (SCR-C-04),
 * actions required before participation, invitations and offers, results and follow-up, and
 * renewal opportunities. Promotional messages never appear here (they stay in the inbox), so
 * marketing cannot obscure today's activity or an unresolved registration.
 *
 * Sources, all answered by the API under its own authorization: `GET /v1/me` (who the person may
 * view), `GET /v1/me/family-calendar` (next activity), `GET /v1/me/inbox` (changes, actions,
 * invitations, results, renewals), `GET /v1/enrollments?status=pending` per participant and
 * `GET /v1/operations/{id}` (registrations needing something). Each section has its own state; the
 * page states the age of what it shows (§4.15) and the SCR-C-40 banner covers connectivity.
 * Fixtures do not appear in the next-activity slot: the API has no customer read of upcoming
 * fixtures across a person's teams (reported in the README).
 */
import type { Schema } from '@sportspark/api-client';
import { useRouter, type Href } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import { nextActivity } from '../../features/today/calendar';
import { NextActivityCard } from '../../features/today/NextActivityCard';
import { noticeSection, type NoticeSection } from '../../features/today/notices';
import {
  INBOX_PAGE_SIZE,
  SCHEDULE_WINDOW_DAYS,
  nameOf,
  useCalendarWindow,
  useInbox,
  useMe,
  useOfferings,
  usePersonNames,
} from '../../features/today/queries';
import { Caption, oldestUpdate, Section, SectionQueryState } from '../../features/today/Section';
import { sessionHref, useSessionActivity } from '../../features/today/session-activity';
import { enrollmentStatus, noticeStatus } from '../../features/today/status';
import { displayZone, zoneNotice } from '../../features/today/time';
import { useNow } from '../../providers/AppProviders';
import { RequireSession } from '../../session/RequireSession';
import { Button } from '../../ui/Button';
import { LastUpdated } from '../../ui/LastUpdated';
import { ListRow } from '../../ui/ListRow';
import { Screen } from '../../ui/Screen';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';
import { spacing } from '../../ui/theme';
import { usePendingRegistrations, type PendingRegistration } from './pending-registrations';

type InboxItem = Schema<'InboxItem'>;
type FamilyCalendarItem = Schema<'FamilyCalendarItem'>;

/** How many notices each Home section shows before "See all in notifications". */
const NOTICES_PER_SECTION = 3;

const NOTICE_SECTIONS: readonly { key: NoticeSection; title: string }[] = [
  { key: 'urgent', title: 'Changes affecting you' },
  { key: 'actions', title: 'Actions required' },
  { key: 'invitations', title: 'Invitations and offers' },
  { key: 'results', title: 'Results and follow-up' },
  { key: 'renewals', title: 'Renewal opportunities' },
];

export function unreadCount(items: readonly InboxItem[]): number {
  return items.filter((i) => !i.readAt && !i.acknowledgedAt && !i.supersededByNotificationId)
    .length;
}

function UnreadBadge() {
  const inbox = useInbox();
  const items = inbox.data?.items;
  if (!items) return null;
  const count = unreadCount(items);
  if (count === 0) return null;
  const more = count >= INBOX_PAGE_SIZE && inbox.data?.nextCursor ? '+' : '';
  return <StatusBadge tone="info" label={`${count}${more} unread`} testID="home-unread" />;
}

function openNotice(router: ReturnType<typeof useRouter>, item: InboxItem) {
  router.push({ pathname: '/inbox', params: { open: item.attemptId } } as Href);
}

function NoticeRows({ items }: { items: InboxItem[] }) {
  const router = useRouter();
  return (
    <View accessibilityRole="list">
      {items.map((item) => (
        <ListRow
          key={item.attemptId}
          title={item.title}
          detail={item.body}
          status={noticeStatus(item)}
          onPress={() => openNotice(router, item)}
          accessibilityHint="Opens the notice in your notifications"
          testID={`home-notice-${item.attemptId}`}
        />
      ))}
    </View>
  );
}

function RegistrationRows({
  rows,
  names,
  offeringNames,
  testID,
}: {
  rows: PendingRegistration[];
  names: Map<string, string>;
  offeringNames: Map<string, string>;
  testID: string;
}) {
  return (
    <View accessibilityRole="list">
      {rows.map(({ enrollment, operation }) => {
        const offeringName = offeringNames.get(enrollment.offeringId) ?? 'Registration';
        return (
          <ListRow
            key={enrollment.id}
            title={offeringName}
            detail={`For: ${nameOf(names, enrollment.participantPersonId)}`}
            status={enrollmentStatus(enrollment, { offeringName, operation })}
            testID={`${testID}-${enrollment.id}`}
          />
        );
      })}
    </View>
  );
}

function NextActivitySection({
  item,
  names,
}: {
  item: FamilyCalendarItem;
  names: Map<string, string>;
}) {
  const router = useRouter();
  const { model } = useSessionActivity(item, nameOf(names, item.personId));
  if (!model) return null;
  const href = sessionHref(item);
  const notice = zoneNotice(model.zone, model.start ?? item.start);
  return (
    <>
      <NextActivityCard model={model} onOpen={href ? () => router.push(href as Href) : undefined} />
      {notice ? <Caption>{notice}</Caption> : null}
    </>
  );
}

function HomeContent() {
  const router = useRouter();
  const now = useNow();
  const zone = displayZone(null);
  const me = useMe();
  const inbox = useInbox();
  const calendar = useCalendarWindow(now, SCHEDULE_WINDOW_DAYS, zone.zone);
  const registrations = usePendingRegistrations(me.data);

  const calendarItems = calendar.data?.items ?? [];
  const next = nextActivity(calendarItems, now);
  const allRegistrations = [...registrations.recovery, ...registrations.pending];
  const names = usePersonNames(
    [
      ...(next ? [next.personId] : []),
      ...allRegistrations.map((r) => r.enrollment.participantPersonId),
    ],
    me.data,
  );
  const offerings = useOfferings(allRegistrations.map((r) => r.enrollment.offeringId));
  const offeringNames = new Map([...offerings].map(([id, o]) => [id, o.name]));

  if (me.data === undefined) {
    return (
      <SectionQueryState
        read={me}
        label="your home"
        unavailable={{
          description:
            'Your account details are not available. Contact the front desk if this continues.',
        }}
      />
    );
  }

  const bySection = new Map<NoticeSection, InboxItem[]>();
  for (const item of inbox.data?.items ?? []) {
    const section = noticeSection(item, now);
    if (!section) continue;
    bySection.set(section, [...(bySection.get(section) ?? []), item]);
  }
  const urgent = bySection.get('urgent') ?? [];
  const nothingAtAll =
    calendar.data !== undefined &&
    inbox.data !== undefined &&
    !registrations.loading &&
    !next &&
    allRegistrations.length === 0 &&
    bySection.size === 0;

  const updatedAt = oldestUpdate([
    me.updatedAt,
    inbox.updatedAt,
    calendar.updatedAt,
    registrations.updatedAt,
  ]);

  return (
    <View testID="home-content">
      <LastUpdated at={updatedAt} now={now} />

      {registrations.recovery.length > 0 ? (
        <Section title="Registration being completed" testID="home-recovery">
          <Caption>
            Do not pay again. Your payment was received and the facility&apos;s team is completing
            the registration; it will show here as confirmed or with what happens next.
          </Caption>
          <RegistrationRows
            rows={registrations.recovery}
            names={names}
            offeringNames={offeringNames}
            testID="home-recovery-row"
          />
        </Section>
      ) : null}

      {nothingAtAll ? (
        <StateView
          variant="empty"
          title="Nothing scheduled yet"
          description="Your next activity, changes and the actions you need to take will appear here. Find leagues, programs, camps and more in Discover."
          actionLabel="Open Discover"
          onAction={() => router.push('/discover')}
        />
      ) : null}

      {urgent.length > 0 ? (
        <Section title="Changes affecting you" testID="home-urgent">
          <NoticeRows items={urgent.slice(0, NOTICES_PER_SECTION)} />
        </Section>
      ) : null}

      {!nothingAtAll ? (
        <Section title="Next activity" testID="home-next">
          <SectionQueryState
            read={calendar}
            label="your next activity"
            unavailable={{ description: 'Your schedule is not available right now.' }}
          />
          {calendar.data !== undefined && next ? (
            <NextActivitySection item={next} names={names} />
          ) : null}
          {calendar.data !== undefined && !next ? (
            <StateView
              variant="empty"
              title="No upcoming activities"
              description={`Nothing is scheduled for you or your family in the next ${SCHEDULE_WINDOW_DAYS} days.`}
              actionLabel="Open Discover"
              onAction={() => router.push('/discover')}
            />
          ) : null}
        </Section>
      ) : null}

      {registrations.pending.length > 0 || (bySection.get('actions') ?? []).length > 0 ? (
        <Section title="Actions required" testID="home-actions">
          <RegistrationRows
            rows={registrations.pending}
            names={names}
            offeringNames={offeringNames}
            testID="home-registration"
          />
          <NoticeRows items={(bySection.get('actions') ?? []).slice(0, NOTICES_PER_SECTION)} />
        </Section>
      ) : null}
      {registrations.error ? (
        <StateView variant="error" error={registrations.error} onRetry={registrations.refetch} />
      ) : null}

      {NOTICE_SECTIONS.filter((s) => s.key !== 'urgent' && s.key !== 'actions').map((s) => {
        const items = bySection.get(s.key) ?? [];
        if (items.length === 0) return null;
        return (
          <Section key={s.key} title={s.title} testID={`home-${s.key}`}>
            <NoticeRows items={items.slice(0, NOTICES_PER_SECTION)} />
          </Section>
        );
      })}

      {inbox.data === undefined ? (
        <SectionQueryState
          read={inbox}
          label="your notices"
          unavailable={{ description: 'Your notices are not available right now.' }}
        />
      ) : null}
    </View>
  );
}

export function HomeScreen() {
  const router = useRouter();
  return (
    <Screen>
      <View style={styles.quick}>
        <Button
          label="Show facility pass"
          onPress={() => router.push('/pass')}
          testID="home-pass"
        />
        <Button
          label="Open notifications"
          variant="secondary"
          onPress={() => router.push('/inbox')}
          testID="home-inbox"
        />
        <UnreadBadge />
      </View>
      <RequireSession what="your next activity and the actions you need to take">
        <HomeContent />
      </RequireSession>
    </Screen>
  );
}

const styles = StyleSheet.create({
  quick: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.lg,
  },
});
