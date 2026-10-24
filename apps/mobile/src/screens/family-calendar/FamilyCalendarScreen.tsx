/**
 * SCR-C-19 Family calendar (SPK-YOUTH-007, SPK-IAM-003, SPK-ENTRY-007, SPK-SCHED-008, SPK-UX-008,
 * SPK-UX-009): every child the API lets this person view, with their own activities, one week at
 * a time; a filter per person; overlapping commitments highlighted, never prevented.
 *
 * - `GET /v1/me/family-calendar` decides who appears (`participantPersonIds`: the caller and each
 *   person they currently hold `view` over). A child whose grant is missing or revoked is absent;
 *   the screen never lists people from anywhere else.
 * - Overlaps come from the API (`overlaps`) and are marked with a glyph and words, not colour. The
 *   parent may knowingly accept an overlap (SPK-YOUTH-007); further handling is DEC-050.
 * - Pickup arrangements (choosing who collects a child from a supervised session) are not offered:
 *   supervised pickup applicability is DEC-075 (Product owner) and the pickup procedure DEC-005
 *   (Operations), and the API has no customer command for it. Schedule visibility never implies
 *   pickup authority (SPK-ENTRY-007).
 * - Names: "You" and given names only (§4.14); ids in routes are opaque.
 */
import type { Schema } from '@sportspark/api-client';
import { useRouter, type Href } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { calendarWindowQuery, groupByDay, overlapIndex } from '../../features/today/calendar';
import { nameOf, useMe, usePersonNames, useSignedIn } from '../../features/today/queries';
import { Caption, Section, SectionQueryState } from '../../features/today/Section';
import { sessionHref } from '../../features/today/session-activity';
import { calendarItemStatus } from '../../features/today/status';
import {
  addLocalDays,
  displayZone,
  formatDay,
  formatTime,
  localDayKey,
  zoneAbbreviation,
  zoneNotice,
} from '../../features/today/time';
import { useApiQuery } from '../../api/useApiQuery';
import { useNow } from '../../providers/AppProviders';
import { RequireSession } from '../../session/RequireSession';
import { Button } from '../../ui/Button';
import { LastUpdated } from '../../ui/LastUpdated';
import { ListRow } from '../../ui/ListRow';
import { Screen } from '../../ui/Screen';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';
import { colors, MIN_TOUCH_SIZE, spacing, type } from '../../ui/theme';

type FamilyCalendar = Schema<'FamilyCalendar'>;
type FamilyCalendarItem = Schema<'FamilyCalendarItem'>;

const WEEK_DAYS = 7;
const EVERYONE = 'everyone';

/** "Overlaps with Swim club (Sam)" for each item that overlaps another (SPK-YOUTH-007). */
export function overlapNotes(
  calendar: FamilyCalendar,
  names: Map<string, string>,
): Map<string, string> {
  const byId = new Map(calendar.items.map((i) => [i.id, i]));
  const notes = new Map<string, string>();
  for (const [id, others] of overlapIndex(calendar)) {
    const parts = others.flatMap((otherId) => {
      const other = byId.get(otherId);
      return other ? [`${other.title} (${nameOf(names, other.personId)})`] : [];
    });
    if (parts.length > 0) notes.set(id, `Overlaps with ${parts.join(', ')}`);
  }
  return notes;
}

function FilterChips({
  people,
  names,
  selected,
  onSelect,
}: {
  people: string[];
  names: Map<string, string>;
  selected: string;
  onSelect: (id: string) => void;
}) {
  const options = [EVERYONE, ...people];
  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel="Show activities for"
      style={styles.chips}
    >
      {options.map((id) => {
        const label = id === EVERYONE ? 'Everyone' : nameOf(names, id);
        const checked = selected === id;
        return (
          <Pressable
            key={id}
            accessibilityRole="radio"
            accessibilityLabel={label}
            accessibilityState={{ checked }}
            onPress={() => onSelect(id)}
            style={[styles.chip, checked && styles.chipSelected]}
            testID={`filter-${id === EVERYONE ? 'everyone' : id}`}
          >
            <Text style={[styles.chipText, checked && styles.chipTextSelected]}>
              {checked ? '✓ ' : ''}
              {label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function FamilyCalendarContent() {
  const router = useRouter();
  const now = useNow();
  const zone = displayZone(null);
  const [week, setWeek] = useState(0);
  const [filter, setFilter] = useState(EVERYONE);
  const me = useMe();
  const query = calendarWindowQuery(now, week, WEEK_DAYS, zone.zone);
  const calendar = useApiQuery({
    path: '/me/family-calendar',
    request: { query },
    enabled: useSignedIn(),
  });
  const data = calendar.data;
  const names = usePersonNames(data?.participantPersonIds ?? [], me.data);

  const weekStart = new Date(query.from);
  const navigation = (
    <View style={styles.weekNav}>
      <Text style={styles.weekTitle} accessibilityRole="header">
        Week of {formatDay(weekStart, zone.zone)}
      </Text>
      <View style={styles.weekButtons}>
        <Button
          label="Previous week"
          variant="secondary"
          onPress={() => setWeek((w) => w - 1)}
          testID="week-previous"
        />
        {week !== 0 ? (
          <Button
            label="This week"
            variant="secondary"
            onPress={() => setWeek(0)}
            testID="week-current"
          />
        ) : null}
        <Button
          label="Next week"
          variant="secondary"
          onPress={() => setWeek((w) => w + 1)}
          testID="week-next"
        />
      </View>
    </View>
  );

  if (!data) {
    return (
      <View>
        {navigation}
        <SectionQueryState
          read={calendar}
          label="the family calendar"
          unavailable={{ description: 'The family calendar is not available right now.' }}
        />
      </View>
    );
  }

  const people = data.participantPersonIds;
  // A filter for someone the API no longer includes (a grant was removed) falls back to everyone.
  const activeFilter = filter === EVERYONE || people.includes(filter) ? filter : EVERYONE;
  const notes = overlapNotes(data, names);
  const shown = data.items.filter((i) => activeFilter === EVERYONE || i.personId === activeFilter);
  const groups = new Map(groupByDay(shown, zone.zone).map((g) => [g.key, g]));
  const days = Array.from({ length: WEEK_DAYS }, (_, i) => addLocalDays(weekStart, i, zone.zone));
  const overlapCount = data.overlaps.filter(
    (o) => activeFilter === EVERYONE || o.personIds.includes(activeFilter),
  ).length;
  const notice = zoneNotice(zone, weekStart);

  return (
    <View testID="family-calendar">
      <LastUpdated at={calendar.updatedAt} now={now} />
      {navigation}
      {notice ? <Caption>{notice}</Caption> : null}
      {people.length <= 1 ? (
        <Caption testID="family-only-self">
          No family members are shared with you yet. A child appears here when you hold permission
          to view their schedule.
        </Caption>
      ) : null}
      <FilterChips people={people} names={names} selected={activeFilter} onSelect={setFilter} />
      {overlapCount > 0 ? (
        <View style={styles.pad}>
          <StatusBadge
            tone="warning"
            label={`${overlapCount} overlapping commitment${overlapCount === 1 ? '' : 's'} this week`}
            testID="overlap-summary"
          />
          <Caption>Overlaps are highlighted so you can plan around them.</Caption>
        </View>
      ) : null}

      {shown.length === 0 ? (
        <StateView
          variant="empty"
          title="No activities this week"
          description={
            activeFilter === EVERYONE
              ? 'Nothing is scheduled for you or your family this week.'
              : `Nothing is scheduled for ${nameOf(names, activeFilter)} this week.`
          }
        />
      ) : (
        days.map((day) => {
          const key = localDayKey(day, zone.zone);
          const group = groups.get(key);
          return (
            <Section key={key} title={formatDay(day, zone.zone)} testID={`family-day-${key}`}>
              {group ? (
                <View accessibilityRole="list">
                  {group.items.map((item: FamilyCalendarItem) => {
                    const href = sessionHref(item);
                    const overlap = notes.get(item.id);
                    const time = `${formatTime(item.start, zone.zone)} to ${formatTime(item.end, zone.zone)} ${zoneAbbreviation(item.start, zone.zone)}`;
                    return (
                      <ListRow
                        key={item.id}
                        title={`${nameOf(names, item.personId)}: ${item.title}`}
                        detail={overlap ? `${time}. ▲ ${overlap}` : time}
                        status={calendarItemStatus(item)}
                        onPress={href ? () => router.push(href as Href) : undefined}
                        accessibilityHint={href ? 'Opens the activity' : undefined}
                        testID={`family-item-${item.id}`}
                      />
                    );
                  })}
                </View>
              ) : (
                <Caption>Nothing scheduled.</Caption>
              )}
            </Section>
          );
        })
      )}

      <Section title="Pickup arrangements">
        <StateView
          variant="pending-decision"
          subject="Choosing who collects a child from a supervised session"
          decisions={['DEC-075', 'DEC-005']}
          owner="Product owner (DEC-075); Operations (DEC-005)"
        />
        <Caption>
          Seeing a child&apos;s schedule does not by itself allow collecting them; staff check
          current pickup permission at release.
        </Caption>
      </Section>
    </View>
  );
}

export function FamilyCalendarScreen() {
  return (
    <Screen>
      <RequireSession what="your family calendar">
        <FamilyCalendarContent />
      </RequireSession>
    </Screen>
  );
}

const styles = StyleSheet.create({
  pad: { paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, gap: spacing.xs },
  weekNav: { padding: spacing.lg, gap: spacing.sm },
  weekTitle: { ...type.heading, color: colors.text },
  weekButtons: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  chip: {
    minHeight: MIN_TOUCH_SIZE,
    minWidth: MIN_TOUCH_SIZE,
    paddingHorizontal: spacing.md,
    justifyContent: 'center',
    borderRadius: 22,
    borderWidth: 1.5,
    borderColor: colors.primary,
    backgroundColor: colors.background,
  },
  chipSelected: { backgroundColor: colors.primary },
  chipText: { ...type.body, color: colors.primary, fontWeight: '600' },
  chipTextSelected: { color: colors.primaryText },
});
