/**
 * Home "This week" (redesign handoff 1b, INTERACTIONS 1b rows 9 and 10; SPK-YOUTH-007): a strip of
 * the seven days of this week on the facility's clock, with one dot per person who has something
 * that day in their person colour (today is the night-filled day), then the next few activities as
 * rows: time, a stripe in the activity's kind colour, what and who, and the person's avatar. A row
 * opens the game or the activity. "Calendar" switches to the Calendar tab with the same filter.
 *
 * Dots are never the only cue (SPK-UX-009): each day is read as "Saturday 21, today: Maya, Leo".
 */
import type { Schema } from '@sportspark/api-client';
import { useRouter, type Href } from 'expo-router';
import { Pressable, View } from 'react-native';
import type { HouseholdPerson } from '../../features/home/household';
import { dayWord, shortTime, timeParts } from '../../features/home/when';
import { entryPersonIds, type TodayEntry } from '../../features/today/entries';
import { fixtureTitle, venueOf } from '../../features/today/fixture-model';
import { sessionHref } from '../../features/today/session-activity';
import { addLocalDays, formatDay, localDayKey, startOfLocalDay } from '../../features/today/time';
import { Avatar } from '../../ui/Avatar';
import { personColorOf } from '../../ui/person-colors';
import { Text } from '../../ui/Text';
import {
  fonts,
  layout,
  makeStyles,
  radius,
  spacing,
  tabular,
  type,
  useTheme,
} from '../../ui/theme';

/** "Mon". */
function shortWeekday(day: Date, zone: string): string {
  return formatDay(day, zone).split(',')[0] as string;
}

type MyTeamEntry = Schema<'MyTeamEntry'>;

const LONG_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function WeekStrip({
  entries,
  people,
  teams,
  now,
  zone,
}: {
  entries: readonly TodayEntry[];
  people: readonly HouseholdPerson[];
  teams: readonly MyTeamEntry[] | undefined;
  now: Date;
  zone: string;
}) {
  const styles = useStyles();
  const theme = useTheme();
  const today = startOfLocalDay(now, zone);
  const todayKey = localDayKey(today, zone);
  // Monday of this week on the facility clock.
  const weekday = new Date(`${todayKey}T12:00:00Z`).getUTCDay();
  const monday = addLocalDays(today, -((weekday + 6) % 7), zone);
  const days = Array.from({ length: 7 }, (_, i) => addLocalDays(monday, i, zone));
  const byDay = new Map<string, Set<string>>();
  for (const entry of entries) {
    const key = localDayKey(entry.start, zone);
    const set = byDay.get(key) ?? new Set<string>();
    for (const id of entryPersonIds(entry, teams)) set.add(id);
    byDay.set(key, set);
  }
  return (
    <View style={styles.strip} testID="home-week-strip">
      {days.map((day) => {
        const key = localDayKey(day, zone);
        const isToday = key === todayKey;
        const who = people.filter((p) => byDay.get(key)?.has(p.id));
        const dayIndex = new Date(`${key}T12:00:00Z`).getUTCDay();
        const label = `${LONG_DAYS[dayIndex]} ${Number(key.slice(8))}${isToday ? ', today' : ''}${
          who.length > 0 ? `: ${who.map((p) => p.givenName).join(', ')}` : ''
        }`;
        return (
          <View
            key={key}
            style={[styles.day, isToday ? styles.today : null]}
            accessible
            accessibilityLabel={label}
            testID={`week-day-${key}`}
          >
            <Text style={[styles.weekday, isToday ? styles.todayWeekday : null]}>
              {shortWeekday(day, zone)}
            </Text>
            <Text style={[styles.date, isToday ? styles.todayDate : null]}>
              {Number(key.slice(8))}
            </Text>
            <View style={styles.dots}>
              {who.slice(0, 3).map((p) => {
                const color = personColorOf(theme, p.slot);
                return (
                  <View
                    key={p.id}
                    style={[styles.dot, { backgroundColor: isToday ? color.tint : color.onTint }]}
                  />
                );
              })}
            </View>
          </View>
        );
      })}
    </View>
  );
}

export function WeekRows({
  entries,
  people,
  teams,
  names,
  now,
  zone,
}: {
  entries: readonly TodayEntry[];
  people: readonly HouseholdPerson[];
  teams: readonly MyTeamEntry[] | undefined;
  names: Map<string, string>;
  now: Date;
  zone: string;
}) {
  const styles = useStyles();
  const theme = useTheme();
  const router = useRouter();
  if (entries.length === 0) return null;
  return (
    <View style={styles.card} accessibilityRole="list" testID="home-week-rows">
      {entries.map((entry, index) => {
        const ids = entryPersonIds(entry, teams);
        const person = people.find((p) => ids.includes(p.id));
        const who = person
          ? person.self
            ? 'You'
            : person.givenName
          : (names.get(ids[0] ?? '') ?? '');
        const entryZone = entry.zone.zone || zone;
        const [time, period] = timeParts(entry.start, entryZone);
        const day = dayWord(entry.start, now, entryZone);
        const kindColor =
          entry.type === 'fixture'
            ? theme.kindColors.league
            : entry.item.kind === 'session_booking'
              ? theme.kindColors.rental
              : theme.kindColors.program;
        const title = entry.type === 'fixture' ? fixtureTitle(entry.fixture) : entry.item.title;
        const place =
          entry.type === 'fixture'
            ? (venueOf(entry.fixture)?.resources[0]?.name ?? venueOf(entry.fixture)?.facilityName)
            : null;
        const line = [who, place, `to ${shortTime(entry.end, entryZone)}`]
          .filter(Boolean)
          .join(' · ');
        const href =
          entry.type === 'fixture'
            ? ({ pathname: '/fixtures/[id]', params: { id: entry.fixture.id } } as Href)
            : (sessionHref(entry.item) as Href | null);
        const when = day === 'Today' ? time : `${day} ${time}`;
        return (
          <Pressable
            key={entry.id}
            onPress={href ? () => router.push(href) : undefined}
            disabled={!href}
            accessibilityRole="button"
            accessibilityLabel={`${title}. ${who}. ${day === 'Today' ? 'Today' : formatDay(entry.start, entryZone)} at ${time} ${period}`}
            style={({ pressed }) => [
              styles.row,
              index > 0 ? styles.divider : null,
              pressed ? styles.pressed : null,
            ]}
            testID={`week-row-${entry.id}`}
          >
            <View style={styles.time}>
              <Text style={styles.timeText}>{when}</Text>
              <Text style={styles.period}>{period}</Text>
            </View>
            <View style={[styles.stripe, { backgroundColor: kindColor }]} />
            <View style={styles.words}>
              <Text variant="callout" style={styles.rowTitle} numberOfLines={1}>
                {title}
              </Text>
              <Text variant="footnote" tone="muted" numberOfLines={1}>
                {line}
              </Text>
            </View>
            {person ? (
              <Avatar
                name={person.givenName}
                id={person.id}
                personColor={personColorOf(theme, person.slot)}
                size="sm"
                decorative
              />
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
}

const useStyles = makeStyles(({ colors }) => ({
  strip: { flexDirection: 'row', gap: spacing.xs, marginHorizontal: layout.gutter },
  day: {
    flex: 1,
    alignItems: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
  },
  today: { backgroundColor: colors.night },
  weekday: { ...fonts.semibold, fontSize: 12, lineHeight: 16, color: colors.textMuted },
  todayWeekday: { color: colors.floodlight },
  date: { ...fonts.bold, fontSize: 17, lineHeight: 22, color: colors.text },
  todayDate: { color: colors.onNight },
  dots: { flexDirection: 'row', gap: 3, height: 6 },
  dot: { width: 6, height: 6, borderRadius: radius.pill },
  card: {
    marginHorizontal: layout.gutter,
    paddingHorizontal: 14,
    paddingVertical: spacing.xs,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.background,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: 10,
    minHeight: 56,
  },
  divider: { borderTopWidth: 1, borderTopColor: colors.divider },
  pressed: { opacity: 0.7 },
  time: { width: 64 },
  timeText: { ...tabular(type.heading), ...fonts.bold, color: colors.text },
  period: { ...fonts.regular, fontSize: 12, lineHeight: 16, color: colors.textMuted },
  stripe: { width: 4, alignSelf: 'stretch', borderRadius: 4 },
  words: { flex: 1, gap: 1 },
  rowTitle: { ...fonts.bold },
}));
