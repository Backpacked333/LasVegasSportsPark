/**
 * SCR-C-19 Family calendar (SPK-YOUTH-007, SPK-IAM-003, SPK-ENTRY-007, SPK-SCHED-008, SPK-PLACE-004,
 * SPK-UX-008, SPK-UX-009): every child the API lets this person view, with their own activities
 * and their teams' fixtures, one week at a time; a filter per person; overlapping commitments
 * highlighted, never prevented.
 *
 * - `GET /v1/me/family-calendar` decides who appears (`participantPersonIds`: the caller and each
 *   person they currently hold `view` over). A child whose grant is missing or revoked is absent;
 *   the screen never lists people from anywhere else. `GET /v1/me/fixtures` adds the fixtures of
 *   the teams those people are on, attributed through `GET /v1/me/team-entries` (CMP-02).
 * - SPK-SCHED-008: times are on each activity's facility clock (`timezone`, `venue.timezone`); the
 *   week's days are laid out on the facility clock when every activity shares one, otherwise on the
 *   device's, and the screen says when it falls back.
 * - Overlaps between sessions and bookings come from the API (`overlaps`); a fixture overlapping
 *   another commitment of the same person is marked too (the same half-open comparison). Both
 *   are marked with a glyph and words, not colour. The parent may knowingly accept an overlap
 *   (SPK-YOUTH-007); further handling is DEC-050.
 * - Pickup sessions (SPK-PLACE-004, DEC-082, capability `pickup_sessions`, enforced): a booked
 *   pickup session is on the calendar as the API serves it, labelled "Pickup session" from its
 *   offering's kind. Finding more is offered only while the switch is on; while it is off the
 *   section says so and booked ones stay listed (reads are never gated).
 * - Pickup arrangements (choosing who collects a child from a supervised session) are not offered:
 *   supervised pickup applicability is DEC-075 (Product owner, its switch only records the
 *   decision) and the pickup procedure DEC-005 (Operations), and the API has no customer command
 *   for it. Schedule visibility never implies pickup authority (SPK-ENTRY-007).
 * - Names: "You" and given names only (§4.14); ids in routes are opaque.
 */
import { presentationForError, type Schema } from '@sportspark/api-client';
import { useRouter, type Href } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { usePermissions } from '../../api/permissions';
import { calendarWindowQuery, overlapIndex } from '../../features/today/calendar';
import {
  entryPersonIds,
  fixtureOverlaps,
  groupEntriesByDay,
  mergeEntries,
  type TodayEntry,
} from '../../features/today/entries';
import { fixtureCardModel, fixtureTitle } from '../../features/today/fixture-model';
import {
  nameOf,
  useMe,
  useMyFixtures,
  useMyTeams,
  useOfferings,
  usePersonNames,
  useSignedIn,
} from '../../features/today/queries';
import { Caption, Section, SectionQueryState } from '../../features/today/Section';
import { sessionHref } from '../../features/today/session-activity';
import { calendarItemStatus, fixtureStatus } from '../../features/today/status';
import {
  daysInWindow,
  displayZone,
  formatDay,
  formatTime,
  localDayKey,
  sharedZone,
  zoneAbbreviation,
  zoneNotice,
  zoneOf,
} from '../../features/today/time';
import { useApiQuery } from '../../api/useApiQuery';
import { useNow } from '../../providers/AppProviders';
import { RequireSession } from '../../session/RequireSession';
import { Button } from '../../ui/Button';
import { CapabilityGate } from '../../ui/CapabilityGate';
import { LastUpdated } from '../../ui/LastUpdated';
import { ListRow } from '../../ui/ListRow';
import { Screen } from '../../ui/Screen';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';
import { colors, MIN_TOUCH_SIZE, spacing, type } from '../../ui/theme';

type FamilyCalendar = Schema<'FamilyCalendar'>;
type MyTeamEntry = Schema<'MyTeamEntry'>;

const WEEK_DAYS = 7;
const EVERYONE = 'everyone';

/** The label of a booked session whose offering is a pickup session (SPK-PLACE-004). */
export const PICKUP_SESSION_LABEL = 'Pickup session';

/** A display title for an entry: the calendar's title or "Lions vs Tigers". */
function entryTitle(entry: TodayEntry): string {
  return entry.type === 'session' ? entry.item.title : fixtureTitle(entry.fixture);
}

/**
 * "Overlaps with Swim club (Sam)" for each entry that overlaps another (SPK-YOUTH-007): the API's
 * session overlaps plus fixtures overlapping a commitment of the same person.
 */
export function overlapNotes(
  calendar: FamilyCalendar,
  entries: readonly TodayEntry[],
  teams: readonly MyTeamEntry[] | undefined,
  names: Map<string, string>,
): Map<string, string> {
  const byEntryId = new Map(entries.map((e) => [e.id, e]));
  const itemEntry = (itemId: string) => byEntryId.get(itemId) ?? byEntryId.get(`item:${itemId}`);
  const others = new Map<string, string[]>();
  const add = (a: string, b: string) => others.set(a, [...(others.get(a) ?? []), b]);
  for (const [itemId, ids] of overlapIndex(calendar)) {
    for (const otherId of ids) {
      const a = itemEntry(itemId);
      const b = itemEntry(otherId);
      if (a && b) add(a.id, b.id);
    }
  }
  for (const o of fixtureOverlaps(entries, teams)) {
    add(o.ids[0], o.ids[1]);
    add(o.ids[1], o.ids[0]);
  }
  const notes = new Map<string, string>();
  for (const [id, ids] of others) {
    const parts = [...new Set(ids)].flatMap((otherId) => {
      const other = byEntryId.get(otherId);
      if (!other) return [];
      const who = entryPersonIds(other, teams)
        .map((p) => nameOf(names, p))
        .join(', ');
      return [who ? `${entryTitle(other)} (${who})` : entryTitle(other)];
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
  const device = displayZone(null);
  const [week, setWeek] = useState(0);
  const [filter, setFilter] = useState(EVERYONE);
  const me = useMe();
  const signedIn = useSignedIn();
  // The window is cut at the device's local midnight (the request is the same for every screen);
  // the days inside it are laid out on the facility clock below.
  const query = calendarWindowQuery(now, week, WEEK_DAYS, device.zone);
  const calendar = useApiQuery({
    path: '/me/family-calendar',
    request: { query },
    enabled: signedIn,
  });
  const fixturesRead = useMyFixtures(query);
  const teams = useMyTeams();
  const data = calendar.data;
  const fixturesHidden =
    fixturesRead.error !== null && presentationForError(fixturesRead.error) === 'unavailable';
  const entries = mergeEntries(data?.items ?? [], fixturesHidden ? [] : (fixturesRead.data ?? []));
  const offerings = useOfferings(
    entries.flatMap((e) => (e.type === 'session' ? [e.item.offeringId] : [])),
  );
  const names = usePersonNames(
    [
      ...(data?.participantPersonIds ?? []),
      ...entries.flatMap((e) => entryPersonIds(e, teams.data)),
    ],
    me.data,
  );

  const weekStart = new Date(query.from);
  // One facility clock for the days when every activity shares it, else the device's.
  const dayZone = zoneOf(sharedZone(entries.map((e) => (e.zone.facility ? e.zone.zone : null))));
  const navigation = (
    <View style={styles.weekNav}>
      <Text style={styles.weekTitle} accessibilityRole="header">
        Week of {formatDay(weekStart, device.zone)}
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
  const notes = overlapNotes(data, entries, teams.data, names);
  const shown = entries.filter(
    (e) => activeFilter === EVERYONE || entryPersonIds(e, teams.data).includes(activeFilter),
  );
  const groups = new Map(
    groupEntriesByDay(
      // Grouped on the day clock, so each entry lands in one of the days laid out below.
      shown.map((e) => ({ ...e, zone: dayZone })),
    ).map((g) => [g.key, g]),
  );
  const days = daysInWindow(weekStart, new Date(query.to), dayZone.zone);
  // Pairs of overlapping commitments: the API's (sessions and bookings) and those with fixtures.
  const overlapCount = [
    ...data.overlaps.map((o) => o.personIds),
    ...fixtureOverlaps(entries, teams.data).map((o) => o.personIds),
  ].filter((personIds) => activeFilter === EVERYONE || personIds.includes(activeFilter)).length;
  const deviceClock = shown.find((e) => !e.zone.facility);
  const notice = deviceClock ? zoneNotice(deviceClock.zone, deviceClock.start) : null;
  const fixturesFailed =
    fixturesRead.error !== null && !fixturesHidden && fixturesRead.data === undefined;

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
      {fixturesFailed ? (
        <View testID="family-fixtures-error">
          <Caption>Team fixtures could not be loaded.</Caption>
          <SectionQueryState read={fixturesRead} label="team fixtures" />
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
          const key = localDayKey(day, dayZone.zone);
          const group = groups.get(key);
          return (
            <Section key={key} title={formatDay(day, dayZone.zone)} testID={`family-day-${key}`}>
              {group ? (
                <View accessibilityRole="list">
                  {group.entries.map((grouped) => {
                    // The row keeps the entry's own facility clock.
                    const entry = shown.find((e) => e.id === grouped.id) ?? grouped;
                    const z = entry.zone.zone;
                    const time = `${formatTime(entry.start, z)} to ${formatTime(entry.end, z)} ${zoneAbbreviation(entry.start, z)}`;
                    const overlap = notes.get(entry.id);
                    if (entry.type === 'fixture') {
                      const card = fixtureCardModel({
                        fixture: entry.fixture,
                        teams: teams.data,
                        names,
                        change: null,
                      });
                      return (
                        <ListRow
                          key={entry.id}
                          title={`${card.participant}: ${fixtureTitle(entry.fixture)}`}
                          detail={[time, card.location, overlap ? `▲ ${overlap}` : null]
                            .filter(Boolean)
                            .join('. ')}
                          status={fixtureStatus(entry.fixture.status)}
                          onPress={() =>
                            router.push({
                              pathname: '/fixtures/[id]',
                              params: { id: entry.fixture.id },
                            } as Href)
                          }
                          accessibilityHint="Opens the fixture"
                          testID={`family-fixture-${entry.fixture.id}`}
                        />
                      );
                    }
                    const item = entry.item;
                    const href = sessionHref(item);
                    const pickup =
                      offerings.get(item.offeringId)?.kind === 'pickup'
                        ? PICKUP_SESSION_LABEL
                        : null;
                    return (
                      <ListRow
                        key={entry.id}
                        title={`${nameOf(names, item.personId)}: ${item.title}`}
                        detail={[time, pickup, overlap ? `▲ ${overlap}` : null]
                          .filter(Boolean)
                          .join('. ')}
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

      <PickupSessions onFind={() => router.push('/discover')} />

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

/**
 * Pickup sessions (SPK-PLACE-004, DEC-082): finding more is offered while the organization has
 * the capability on; while it is off the section says so, and booked ones stay on the calendar.
 */
function PickupSessions({ onFind }: { onFind: () => void }) {
  const permissions = usePermissions();
  const on = permissions.isCapabilityEnabled('pickup_sessions') === true;
  return (
    <Section title="Pickup sessions" testID="family-pickup-sessions">
      <CapabilityGate
        capability="pickup_sessions"
        whenOff="notice"
        stillAvailable="Pickup sessions already booked stay on this calendar."
      >
        {on ? (
          <View style={styles.pad}>
            <Caption>
              Book a seat in a pickup session from Discover; booked sessions appear here marked
              &quot;{PICKUP_SESSION_LABEL}&quot;.
            </Caption>
            <Button label="Find pickup sessions" variant="secondary" onPress={onFind} />
          </View>
        ) : null}
      </CapabilityGate>
    </Section>
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
