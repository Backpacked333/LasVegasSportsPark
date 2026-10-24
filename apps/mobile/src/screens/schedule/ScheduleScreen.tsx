/**
 * SCR-C-18 Schedule (SPK-UX-002, SPK-SCHED-006, SPK-SCHED-007, SPK-SCHED-008, SPK-COMMS-005,
 * SPK-UX-008, SPK-UX-009): the signed-in person's activities and those of family members the API
 * lets them view, day by day, with the next-activity card (SCR-C-04) on top and published changes
 * and cancellations shown as old and new details.
 *
 * - `GET /v1/me/family-calendar` (`from`, `to`) is the source; the API includes only people the
 *   caller currently holds `view` over, so a child without that grant is simply absent.
 * - Later weeks load as further windows; what is already shown stays on screen meanwhile.
 * - Changes come from schedule notices in `GET /v1/me/inbox` (`detailsBefore` / `detailsAfter`,
 *   in the facility's own time zone). A canceled session leaves the calendar; its notice says so.
 * - Times use the facility zone when the API states it and the device zone otherwise, labelled.
 * - Customers never see drafts: the calendar and the notices carry published schedules only.
 */
import type { Schema } from '@sportspark/api-client';
import { useRouter, type Href } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { groupByDay, mergeCalendars, nextActivity } from '../../features/today/calendar';
import { ChangeDetails } from '../../features/today/ChangeDetails';
import { NextActivityCard } from '../../features/today/NextActivityCard';
import { upcomingScheduleChanges } from '../../features/today/notices';
import {
  SCHEDULE_WINDOW_DAYS,
  nameOf,
  useCalendarWindows,
  useInbox,
  useMe,
  usePersonNames,
} from '../../features/today/queries';
import { Caption, oldestUpdate, Section, SectionQueryState } from '../../features/today/Section';
import { sessionHref, useSessionActivity } from '../../features/today/session-activity';
import { calendarItemStatus } from '../../features/today/status';
import {
  addLocalDays,
  displayZone,
  formatDay,
  formatTime,
  startOfLocalDay,
  zoneAbbreviation,
  zoneNotice,
} from '../../features/today/time';
import { useNow } from '../../providers/AppProviders';
import { RequireSession } from '../../session/RequireSession';
import { Button } from '../../ui/Button';
import { LastUpdated } from '../../ui/LastUpdated';
import { ListRow } from '../../ui/ListRow';
import { Screen } from '../../ui/Screen';
import { StateView } from '../../ui/StateView';
import { colors, spacing, type } from '../../ui/theme';

type FamilyCalendarItem = Schema<'FamilyCalendarItem'>;

/**
 * How many windows Schedule loads at most: about a year ahead. A display limit, not a policy;
 * each window (SCHEDULE_WINDOW_DAYS) stays inside the API's per-request limit of 120 days.
 */
export const MAX_SCHEDULE_WINDOWS = 13;

function NextCard({ item, participant }: { item: FamilyCalendarItem; participant: string }) {
  const router = useRouter();
  const { model } = useSessionActivity(item, participant);
  if (!model) return null;
  const href = sessionHref(item);
  return (
    <NextActivityCard
      model={model}
      onOpen={href ? () => router.push(href as Href) : undefined}
      testID="schedule-next"
    />
  );
}

function ScheduleContent() {
  const router = useRouter();
  const now = useNow();
  const zone = displayZone(null);
  const [windows, setWindows] = useState(1);
  const me = useMe();
  const inbox = useInbox();
  const reads = useCalendarWindows(now, windows, SCHEDULE_WINDOW_DAYS, zone.zone);
  const loaded = reads.flatMap((r) => (r.data ? [r.data] : []));
  const calendar = mergeCalendars(loaded);
  const names = usePersonNames(calendar?.participantPersonIds ?? [], me.data);
  const first = reads[0];

  if (!first || first.data === undefined || !calendar) {
    return (
      <SectionQueryState
        read={first ?? { data: undefined, error: null }}
        label="your schedule"
        unavailable={{ description: 'Your schedule is not available right now.' }}
      />
    );
  }

  const items = calendar.items.filter((i) => new Date(i.end).getTime() > now.getTime());
  const next = nextActivity(items, now);
  const changes = upcomingScheduleChanges(inbox.data?.items ?? [], now);
  const familyShared = calendar.participantPersonIds.length > 1;
  const shownUntil = addLocalDays(
    startOfLocalDay(now, zone.zone),
    loaded.length * SCHEDULE_WINDOW_DAYS,
    zone.zone,
  );
  const groups = groupByDay(items, zone.zone);
  const notice = zoneNotice(zone, now);
  const later = reads.slice(1).find((r) => r.data === undefined);

  return (
    <View testID="schedule-content">
      <LastUpdated
        at={oldestUpdate([...reads.map((r) => r.updatedAt), inbox.updatedAt])}
        now={now}
      />
      {notice ? <Caption testID="zone-notice">{notice}</Caption> : null}

      {changes.length > 0 ? (
        <Section title="Changes" testID="schedule-changes">
          {changes.map(({ item, change }) => (
            <View key={item.attemptId} style={styles.change}>
              <Text style={styles.changeTitle}>{item.title}</Text>
              <ChangeDetails change={change} testID={`schedule-change-${item.attemptId}`} />
            </View>
          ))}
        </Section>
      ) : null}

      {next ? (
        <Section title="Next activity">
          <NextCard item={next} participant={nameOf(names, next.personId)} />
        </Section>
      ) : null}

      {familyShared ? (
        <View style={styles.pad}>
          <Button
            label="Open family calendar"
            variant="secondary"
            onPress={() => router.push('/family-calendar')}
            testID="schedule-family"
          />
        </View>
      ) : null}

      {groups.length === 0 ? (
        <StateView
          variant="empty"
          title="No activities"
          description={`Nothing is scheduled for you${familyShared ? ' or your family' : ''} before ${formatDay(shownUntil, zone.zone)}. Find leagues, programs and camps in Discover.`}
          actionLabel="Open Discover"
          onAction={() => router.push('/discover')}
        />
      ) : (
        groups.map((group) => (
          <Section key={group.key} title={group.heading} testID={`day-${group.key}`}>
            <View accessibilityRole="list">
              {group.items.map((item) => {
                const href = sessionHref(item);
                const time = `${formatTime(item.start, zone.zone)} to ${formatTime(item.end, zone.zone)} ${zoneAbbreviation(item.start, zone.zone)}`;
                return (
                  <ListRow
                    key={item.id}
                    title={item.title}
                    detail={`${time}. For: ${nameOf(names, item.personId)}`}
                    status={calendarItemStatus(item)}
                    onPress={href ? () => router.push(href as Href) : undefined}
                    accessibilityHint={href ? 'Opens the activity' : undefined}
                    testID={`schedule-item-${item.id}`}
                  />
                );
              })}
            </View>
          </Section>
        ))
      )}

      {later ? (
        <SectionQueryState read={later} label="later activities" />
      ) : windows < MAX_SCHEDULE_WINDOWS ? (
        <View style={styles.pad}>
          <Caption>Showing activities before {formatDay(shownUntil, zone.zone)}.</Caption>
          <Button
            label={`Show the following ${SCHEDULE_WINDOW_DAYS} days`}
            variant="secondary"
            onPress={() => setWindows((w) => Math.min(w + 1, MAX_SCHEDULE_WINDOWS))}
            testID="schedule-more"
          />
        </View>
      ) : null}
    </View>
  );
}

export function ScheduleScreen() {
  return (
    <Screen>
      <RequireSession what="your schedule">
        <ScheduleContent />
      </RequireSession>
    </Screen>
  );
}

const styles = StyleSheet.create({
  pad: { paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, gap: spacing.sm },
  change: { paddingHorizontal: spacing.lg, gap: spacing.xs },
  changeTitle: { ...type.body, fontWeight: '600', color: colors.text },
});
