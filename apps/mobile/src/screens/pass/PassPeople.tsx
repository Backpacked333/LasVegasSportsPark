/**
 * Whose pass is shown (redesign handoff 1j; INTERACTIONS 1j rows 2 and 3; SPK-ENTRY-002,
 * SPK-ENTRY-003, SPK-REG-011, §4.14, §4.15).
 *
 * - A switch on the night surface with each household member the account may act for (the account
 *   holder, and each person `GET /v1/me` lists with `view`), and "All" with two or more. It opens
 *   on the person the screen was asked for (Home's "Show Leo's pass": the `person` route param, an
 *   opaque id), else the account holder.
 * - Under it: the person's given name, what they have today (from the family calendar and the
 *   team games the app has read) and their arrival status from their waivers
 *   (`GET /v1/people/{id}/waivers`): "✓ Cleared to play" when every waiver is current,
 *   "▲ Waiver needed first" otherwise. Offline, the last known status with "as of 8:41".
 * - The code below stays the holder's own opaque reference (SPK-ENTRY-002): one pass for the
 *   family; the desk's scan opens the household and staff choose who arrived (SPK-ENTRY-003). A
 *   separate code per person, the scannable symbol and Wallet are **Pending decision** DEC-023.
 */
import { formatAge, type Schema } from '@sportspark/api-client';
import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { useApiQuery } from '../../api/useApiQuery';
import { useHousehold, type HouseholdPerson } from '../../features/home/household';
import { calendarWindowQuery } from '../../features/today/calendar';
import { entryPersonIds, mergeEntries } from '../../features/today/entries';
import { fixtureTitle } from '../../features/today/fixture-model';
import { useKnownFacilityZone } from '../../features/today/known-zone';
import { useCalendarWindow, useMyFixtures, useMyTeams } from '../../features/today/queries';
import { formatTime, localDayKey } from '../../features/today/time';
import { useConnectivity, useNow } from '../../providers/AppProviders';
import { Text } from '../../ui/Text';
import { fonts, makeStyles, radius, spacing } from '../../ui/theme';

type PersonWaivers = Schema<'PersonWaivers'>;

export type Readiness = 'cleared' | 'waiver' | 'unknown';

/** The arrival status from a person's waivers (SPK-REG-011). */
export function readinessOf(waivers: PersonWaivers | undefined): Readiness {
  if (!waivers) return 'unknown';
  if (waivers.waivers.some((w) => w.status !== 'current')) return 'waiver';
  return 'cleared';
}

export const READINESS_WORDS: Readonly<Record<Readiness, string>> = {
  cleared: '✓ Cleared to play',
  waiver: '▲ Waiver needed first',
  unknown: '● Status not checked',
};

function Readiness({ person, now }: { person: HouseholdPerson; now: Date }) {
  const styles = useStyles();
  const offline = useConnectivity().reachable === false;
  const waivers = useApiQuery({
    path: '/people/{id}/waivers',
    request: { path: { id: person.id } },
  });
  const state = readinessOf(waivers.data);
  const asOf = offline && waivers.updatedAt ? ` · as of ${formatAge(waivers.updatedAt, now)}` : '';
  return (
    <View
      style={[
        styles.status,
        state === 'cleared' ? styles.cleared : state === 'waiver' ? styles.warn : styles.neutral,
      ]}
      accessible
      accessibilityLabel={`${READINESS_WORDS[state].slice(2)}${asOf}`}
      testID="pass-readiness"
    >
      <Text
        style={[
          styles.statusText,
          state === 'cleared'
            ? styles.clearedText
            : state === 'waiver'
              ? styles.warnText
              : styles.neutralText,
        ]}
      >
        {`${READINESS_WORDS[state]}${asOf}`}
      </Text>
    </View>
  );
}

/** Drawn only for a household: one person alone needs no switch (their pass is below). */
export function PassPeople({ initialPersonId }: { initialPersonId: string | null }) {
  const { people, selfId } = useHousehold();
  if (people.length <= 1) return null;
  return <PassPeopleSwitch people={people} selfId={selfId} initialPersonId={initialPersonId} />;
}

function PassPeopleSwitch({
  people,
  selfId,
  initialPersonId,
}: {
  people: readonly HouseholdPerson[];
  selfId: string | null;
  initialPersonId: string | null;
}) {
  const styles = useStyles();
  const now = useNow();
  const zone = useKnownFacilityZone().zone;
  const calendar = useCalendarWindow(now, 1, zone);
  const fixtures = useMyFixtures(calendarWindowQuery(now, 0, 1, zone));
  const teams = useMyTeams();
  const ordered = [...people.filter((p) => p.self), ...people.filter((p) => !p.self)];
  const [chosen, setChosen] = useState<string | 'all' | null>(initialPersonId);
  const current =
    chosen === 'all'
      ? 'all'
      : (ordered.find((p) => p.id === chosen)?.id ?? selfId ?? ordered[0]?.id ?? null);
  const options = [
    ...ordered.map((p) => ({ id: p.id, label: p.givenName })),
    ...(ordered.length > 1 ? [{ id: 'all', label: 'All' }] : []),
  ];
  const today = localDayKey(now, zone);
  const entries = mergeEntries(calendar.data?.items ?? [], fixtures.data ?? []).filter(
    (e) => localDayKey(e.start, e.zone.zone) === today && Date.parse(e.end) > now.getTime(),
  );
  const lineFor = (personId: string): string => {
    const entry = entries.find((e) => entryPersonIds(e, teams.data).includes(personId));
    if (!entry) return 'Nothing booked today';
    const title = entry.type === 'fixture' ? fixtureTitle(entry.fixture) : entry.item.title;
    return `${title} · today ${formatTime(entry.start, entry.zone.zone)}`;
  };
  const shown = current === 'all' ? ordered : ordered.filter((p) => p.id === current);
  return (
    <View style={styles.box} testID="pass-people">
      {options.length > 1 ? (
        <View style={styles.switch} accessibilityRole="radiogroup" accessibilityLabel="Whose pass">
          {options.map((o) => {
            const on = o.id === current;
            return (
              <Pressable
                key={o.id}
                accessibilityRole="radio"
                accessibilityLabel={o.label}
                accessibilityState={{ checked: on, selected: on }}
                onPress={() => setChosen(o.id)}
                style={[styles.option, on ? styles.optionOn : null]}
                testID={`pass-person-${o.label}`}
              >
                <Text style={[styles.optionText, on ? styles.optionTextOn : null]}>{o.label}</Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}
      {shown.map((p) => (
        <View key={p.id} style={styles.person} testID={`pass-for-${p.id}`}>
          <Text style={styles.name}>{p.givenName}</Text>
          <Text style={styles.line}>{lineFor(p.id)}</Text>
          <Readiness person={p} now={now} />
        </View>
      ))}
      {current === 'all' ? (
        <Text style={styles.line}>
          One pass for the family: the front desk chooses who is checking in.
        </Text>
      ) : null}
    </View>
  );
}

const useStyles = makeStyles(({ colors }) => ({
  box: {
    marginHorizontal: spacing.lg + 4,
    marginBottom: spacing.md,
    padding: spacing.md,
    gap: spacing.md,
    borderRadius: radius.xl,
    backgroundColor: colors.night,
  },
  switch: {
    flexDirection: 'row',
    padding: spacing.xs,
    gap: spacing.xs,
    borderRadius: radius.pill,
    backgroundColor: colors.nightRaised,
    borderWidth: 1,
    borderColor: colors.nightLine,
  },
  option: {
    flex: 1,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.pill,
  },
  optionOn: { backgroundColor: colors.floodlight },
  optionText: { ...fonts.semibold, fontSize: 15, color: colors.nightText },
  optionTextOn: { color: colors.onFloodlight },
  person: { alignItems: 'center', gap: spacing.xs },
  name: { ...fonts.bold, fontSize: 26, lineHeight: 32, color: colors.onNight },
  line: {
    ...fonts.regular,
    fontSize: 14,
    lineHeight: 20,
    color: colors.nightText,
    textAlign: 'center',
  },
  status: { paddingHorizontal: spacing.md, paddingVertical: 4, borderRadius: radius.pill },
  cleared: { backgroundColor: colors.floodlight },
  warn: { backgroundColor: colors.nightRaised, borderWidth: 1, borderColor: colors.nightLine },
  neutral: { backgroundColor: colors.nightRaised },
  statusText: { ...fonts.bold, fontSize: 13, lineHeight: 18 },
  clearedText: { color: colors.onFloodlight },
  warnText: { color: colors.floodlight },
  neutralText: { color: colors.nightText },
}));
