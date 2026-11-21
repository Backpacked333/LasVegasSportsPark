/**
 * Home's hero card (redesign handoff 1b, 3a, 3f, 3g; INTERACTIONS 1b rows 1 to 5; SCR-C-04,
 * SPK-UX-004, SPK-CAP-003, SPK-SCHED-008, SPK-UX-009): the next activity of the people shown.
 *
 * - The picture (activity artwork) carries a live pill: "Today · in 2 h 15 min", minutes under an
 *   hour, "Now" from the start time, "Next up · Sat · 9:00 AM" when nothing is on today; it is the
 *   card's one button, named with participant, activity, time with zone, place and status
 *   (`heroLabel`), and opens Game day (`/fixtures/{id}`) or the activity (`/sessions/{id}`).
 * - Under it: Kickoff / Starts with the end time, Where (field, then facility), the latest change
 *   (old and new, SPK-COMMS-005) and the required action; for a game, "Is Maya going?" with the
 *   answer control (`GameAnswer`); for a class whose participant has a waiver to sign, "▲ Leo
 *   can't check in yet" with Sign.
 * - Directions opens the device's maps app at the facility's address (no gate pins exist in the
 *   API yet: the facility address is the handoff's stated fallback). Show pass opens the pass for
 *   that person.
 * - "Arrive by" (handoff) is arrival guidance, **Pending decision** POL-046: not shown.
 * - `CancelledHero` (3g): a game of today the league cancelled: a red header, the game struck
 *   through, the reason from its notice, what happens next, and "See what's next".
 */
import type { Schema } from '@sportspark/api-client';
import { useRouter, type Href } from 'expo-router';
import { Linking, Platform, Pressable, View } from 'react-native';
import { artworkFor } from '../../artwork/artworkFor';
import { GameAnswer } from '../../features/home/GameAnswer';
import { holds, type HouseholdPerson } from '../../features/home/household';
import { PROPOSED } from '../../features/home/proposed';
import { countdown, shortTime } from '../../features/home/when';
import { ChangeDetails } from '../../features/today/ChangeDetails';
import type { TodayEntry } from '../../features/today/entries';
import {
  AVAILABILITY_REQUEST_ACTION,
  fixtureCardModel,
  fixtureRequiredAction,
  mySide,
  venueOf,
} from '../../features/today/fixture-model';
import { whenText, type ActivityCardModel } from '../../features/today/NextActivityCard';
import { latestChangeForEvent, openAvailabilityRequest } from '../../features/today/notices';
import { useFacility } from '../../features/today/queries';
import { sessionHref, useSessionActivity } from '../../features/today/session-activity';
import { formatTime, zoneNotice } from '../../features/today/time';
import { Artwork, type ArtworkSource } from '../../ui/Artwork';
import { Avatar } from '../../ui/Avatar';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { InfoCard } from '../../ui/InfoCard';
import type { personColorOf } from '../../ui/person-colors';
import { StatusBadge } from '../../ui/StatusBadge';
import { Text } from '../../ui/Text';
import {
  continuousCorners,
  elevation,
  fonts,
  layout,
  makeStyles,
  radius,
  spacing,
  tabular,
  type,
  useTheme,
} from '../../ui/theme';

type FixtureDetail = Schema<'FixtureDetail'>;
type MyTeamEntry = Schema<'MyTeamEntry'>;
type InboxItem = Schema<'InboxItem'>;
type FamilyCalendarItem = Schema<'FamilyCalendarItem'>;

export const PLACE_NOT_SHOWN = 'Place not shown yet';

/** The hero card's one name, in reading order (SPK-UX-009). */
export function heroLabel(model: ActivityCardModel): string {
  return [
    model.title,
    `For: ${model.participant}`,
    model.opponent ? `Against: ${model.opponent}` : null,
    `When: ${whenText(model)}`,
    `Where: ${model.location ?? PLACE_NOT_SHOWN}`,
    model.status.label,
  ]
    .filter((part): part is string => !!part)
    .map((part) => part.replace(/\.$/, ''))
    .join('. ');
}

/** The required action in customer words (the shared constant names a "fixture"). */
export function requiredActionText(action: string): string {
  return action === AVAILABILITY_REQUEST_ACTION
    ? 'Answer the availability request for this game.'
    : action;
}

/** "Main Park, Pitch 2" → field "Pitch 2", site "Main Park". */
export function splitPlace(location: string | null | undefined): { field: string; site: string } {
  if (!location) return { field: PLACE_NOT_SHOWN, site: '' };
  const parts = location.split(', ');
  if (parts.length === 1) return { field: parts[0] as string, site: '' };
  return { field: parts.slice(1).join(', '), site: parts[0] as string };
}

/** The maps address for a facility: its address lines, else its name. */
export function mapsQuery(
  facility: { name: string; address: Record<string, unknown> | null } | undefined,
  fallback: string | null,
): string | null {
  const address = facility?.address ?? null;
  const lines = address
    ? Object.values(address).filter((v): v is string => typeof v === 'string' && v.trim() !== '')
    : [];
  const text = lines.length > 0 ? lines.join(', ') : (facility?.name ?? fallback);
  return text ? text : null;
}

function openMaps(query: string) {
  const q = encodeURIComponent(query);
  const url = Platform.select({
    ios: `maps:0,0?q=${q}`,
    android: `geo:0,0?q=${q}`,
    default: `https://maps.apple.com/?q=${q}`,
  });
  void Linking.openURL(url).catch(() => undefined);
}

interface HeroShellProps {
  source: ArtworkSource;
  pill: string | null;
  live: boolean;
  eyebrow: string;
  title: string;
  label: string;
  hint: string;
  onOpen?: () => void;
  children: React.ReactNode;
}

function HeroShell({
  source,
  pill,
  live,
  eyebrow,
  title,
  label,
  hint,
  onOpen,
  children,
}: HeroShellProps) {
  const styles = useStyles();
  const theme = useTheme();
  return (
    <View style={[elevation(theme, 'raised'), styles.card]} testID="next-activity-card">
      <Pressable
        onPress={onOpen}
        disabled={!onOpen}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityHint={hint}
        style={styles.photo}
        testID="hero-photo"
      >
        <Artwork source={source} rounded={false} aspectRatio={390 / 196} style={styles.art} />
        {pill ? (
          <View style={[styles.pill, live ? styles.pillLive : null]} testID="hero-countdown">
            <View style={styles.pillDot} />
            <Text style={styles.pillText}>{pill}</Text>
          </View>
        ) : null}
        <View style={styles.scrim}>
          <Text style={styles.eyebrow} numberOfLines={1}>
            {eyebrow}
          </Text>
          <Text style={styles.title} numberOfLines={2}>
            {title}
          </Text>
        </View>
      </Pressable>
      <View style={styles.body}>{children}</View>
    </View>
  );
}

function Facts({
  timeLabel,
  start,
  end,
  zone,
  location,
}: {
  timeLabel: string;
  start: string | null;
  end: string | null;
  zone: string;
  location: string | null;
}) {
  const styles = useStyles();
  const place = splitPlace(location);
  return (
    <View style={styles.facts}>
      <View style={styles.fact}>
        <Text style={styles.factLabel}>{timeLabel}</Text>
        <Text style={styles.factValue}>{start ? formatTime(start, zone) : 'Not set yet'}</Text>
        {end ? <Text style={styles.factSub}>{`Ends ${shortTime(end, zone)}`}</Text> : null}
      </View>
      <View style={styles.fact}>
        <Text style={styles.factLabel}>Where</Text>
        <Text style={styles.factValue}>{place.field}</Text>
        {place.site ? <Text style={styles.factSub}>{place.site}</Text> : null}
      </View>
    </View>
  );
}

function Actions({
  facilityId,
  location,
  passLabel,
  onPass,
}: {
  facilityId: string | null;
  location: string | null;
  passLabel: string;
  onPass: () => void;
}) {
  const styles = useStyles();
  const facility = useFacility(facilityId);
  const query = mapsQuery(facility.data, location);
  return (
    <View style={styles.actions}>
      <View style={styles.action}>
        <Button
          label="Directions"
          icon="directions"
          variant="secondary"
          block
          disabled={!query}
          onPress={() => query && openMaps(query)}
          accessibilityHint="Opens your maps app at the facility"
          testID="hero-directions"
        />
      </View>
      <View style={styles.action}>
        <Button label={passLabel} icon="qr_code_2" block onPress={onPass} testID="hero-pass" />
      </View>
    </View>
  );
}

export interface TodayHeroProps {
  entry: TodayEntry;
  people: readonly HouseholdPerson[];
  selfId: string | null;
  teams: readonly MyTeamEntry[] | undefined;
  names: Map<string, string>;
  inbox: readonly InboxItem[];
  now: Date;
  /** People with a waiver to sign (Sign opens the sheet for them). */
  needsWaiver: ReadonlySet<string>;
  onSign: (personId: string) => void;
  onPass: (personId: string | null) => void;
}

export function TodayHero(props: TodayHeroProps) {
  return props.entry.type === 'fixture' ? (
    <FixtureHero {...props} fixture={props.entry.fixture} />
  ) : (
    <SessionHero {...props} item={props.entry.item} />
  );
}

function pillFor(start: string | null, end: string | null, now: Date, zone: string) {
  if (!start || !end) return { text: null, live: false };
  const c = countdown(start, end, now, zone);
  if (c.state === 'upcoming') return { text: `Next up · ${c.label}`, live: false };
  return { text: c.label, live: c.state === 'now' };
}

function FixtureHero({
  fixture,
  people,
  selfId,
  teams,
  names,
  inbox,
  now,
  onPass,
}: TodayHeroProps & { fixture: FixtureDetail }) {
  const router = useRouter();
  const latest = latestChangeForEvent(inbox, fixture.schedulingEventId);
  const requiredAction = fixtureRequiredAction(
    fixture,
    selfId,
    openAvailabilityRequest(inbox, fixture.id),
  );
  const model = fixtureCardModel({
    fixture,
    teams,
    names,
    change: latest?.change ?? null,
    requiredAction,
  });
  const mine = mySide(fixture, teams);
  const members = new Set(mine?.team.members.map((m) => m.personId) ?? []);
  // The household member who plays: a child first (the parent answers for them), else oneself.
  const player =
    people.find((p) => !p.self && members.has(p.id)) ?? people.find((p) => members.has(p.id));
  const side = mine ? (mine.side === 'home' ? fixture.home : fixture.away) : null;
  const zone = model.zone.zone;
  const pill = pillFor(model.start, model.end, now, zone);
  const notice = zoneNotice(model.zone, model.start ?? fixture.createdAt);
  const eyebrow = [player?.self ? 'You' : player?.givenName, mine?.team.teamName]
    .filter(Boolean)
    .join(' · ');
  const art = artworkFor({ kind: 'game', title: model.title }, 'wide');
  return (
    <HeroShell
      source={art.source}
      pill={pill.text}
      live={pill.live}
      eyebrow={eyebrow || model.participant}
      title={model.opponent ? `vs ${model.opponent}` : model.title}
      label={heroLabel(model)}
      hint="Opens the game"
      onOpen={() => router.push({ pathname: '/fixtures/[id]', params: { id: fixture.id } } as Href)}
    >
      <Facts
        timeLabel="Kickoff"
        start={model.start}
        end={model.end}
        zone={zone}
        location={model.location ?? null}
      />
      {notice ? (
        <Text variant="footnote" tone="muted">
          {notice}
        </Text>
      ) : null}
      {model.change && model.change.kind !== 'published' ? (
        <ChangeDetails change={model.change} testID="next-activity-card-change" />
      ) : null}
      {model.requiredAction ? (
        <InfoCard
          tone="warning"
          title="Action needed"
          message={requiredActionText(model.requiredAction)}
          testID="next-activity-card-action"
        />
      ) : null}
      {player ? (
        <GameAnswer
          key={`${fixture.id}:${player.id}`}
          fixture={fixture}
          side={side ?? null}
          personId={player.id}
          personName={player.givenName}
          self={player.self}
          selfId={selfId}
          mayAnswer={player.self || (PROPOSED.guardianAnswers && holds(player, 'register'))}
          now={now}
        />
      ) : (
        <StatusBadge {...model.status} />
      )}
      <Actions
        facilityId={venueOf(fixture)?.facilityId ?? null}
        location={model.location ?? null}
        passLabel="Show pass"
        onPass={() => onPass(player?.id ?? null)}
      />
    </HeroShell>
  );
}

function SessionHero({
  item,
  people,
  names,
  now,
  needsWaiver,
  onSign,
  onPass,
}: TodayHeroProps & { item: FamilyCalendarItem }) {
  const router = useRouter();
  const styles = useStyles();
  const person = people.find((p) => p.id === item.personId);
  const participant = person?.self ? 'You' : (names.get(item.personId) ?? person?.givenName ?? '');
  const { model, offering } = useSessionActivity(item, participant);
  if (!model) return null;
  const href = sessionHref(item);
  const zone = model.zone.zone;
  const pill = pillFor(model.start, model.end, now, zone);
  const notice = zoneNotice(model.zone, model.start ?? item.start);
  const art = artworkFor(offering ?? { title: model.title }, 'wide');
  const blocked = needsWaiver.has(item.personId);
  const name = person?.self ? 'You' : (person?.givenName ?? participant);
  return (
    <HeroShell
      source={art.source}
      pill={pill.text}
      live={pill.live}
      eyebrow={participant}
      title={model.title}
      label={heroLabel(model)}
      hint="Opens the activity details"
      onOpen={href ? () => router.push(href as Href) : undefined}
    >
      <Facts
        timeLabel="Starts"
        start={model.start}
        end={model.end}
        zone={zone}
        location={model.location ?? null}
      />
      {notice ? (
        <Text variant="footnote" tone="muted">
          {notice}
        </Text>
      ) : null}
      {model.change && model.change.kind !== 'published' ? (
        <ChangeDetails change={model.change} testID="next-activity-card-change" />
      ) : null}
      {model.requiredAction ? (
        <InfoCard
          tone="warning"
          title="Action needed"
          message={requiredActionText(model.requiredAction)}
          testID="next-activity-card-action"
        />
      ) : null}
      <StatusBadge {...model.status} testID="next-activity-card-status" />
      {blocked ? (
        <View style={styles.blocked} testID="hero-waiver-blocked">
          <Text variant="callout" style={styles.blockedText}>
            <Text variant="callout" style={styles.bold}>
              {`▲ ${name} can't check in yet.`}
            </Text>
            {' The waiver isn’t signed.'}
          </Text>
          <Button
            label="Sign"
            variant="tonal"
            onPress={() => onSign(item.personId)}
            accessibilityLabel={`Sign the waiver for ${name}`}
          />
        </View>
      ) : null}
      <Actions
        facilityId={item.facilityId}
        location={model.location ?? null}
        passLabel={person && !person.self ? `Show ${person.givenName}'s pass` : 'Show pass'}
        onPass={() => onPass(item.personId)}
      />
    </HeroShell>
  );
}

/** 3g: a game of today that was cancelled, until "See what's next". */
export function CancelledHero({
  fixture,
  reason,
  zone,
  player,
  onNext,
}: {
  fixture: FixtureDetail;
  reason: string | null;
  zone: string;
  player: { name: string; color: ReturnType<typeof personColorOf> } | null;
  onNext: () => void;
}) {
  const styles = useStyles();
  const theme = useTheme();
  const router = useRouter();
  const title = fixture.away
    ? `${fixture.home.teamName} vs ${fixture.away.teamName}`
    : fixture.home.teamName;
  const place = venueOf(fixture)?.resources[0]?.name ?? null;
  const was = [
    fixture.scheduledStart ? `Was ${formatTime(fixture.scheduledStart, zone)}` : null,
    place,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <View
      style={[elevation(theme, 'raised'), styles.card]}
      accessible={false}
      testID="home-cancelled"
    >
      <View style={styles.cancelHead} accessible accessibilityLabel={`Cancelled: ${title}`}>
        <Icon name="thunderstorm" size={22} color={theme.colors.primaryText} />
        <Text style={styles.cancelHeadText}>✕ Cancelled</Text>
      </View>
      <View style={styles.body}>
        <View style={styles.cancelRow}>
          {player ? (
            <Avatar name={player.name} personColor={player.color} size="lg" decorative />
          ) : null}
          <View style={styles.cancelWords}>
            <Text variant="headline" style={styles.struck}>
              {title}
            </Text>
            {was ? (
              <Text variant="footnote" tone="muted">
                {was}
              </Text>
            ) : null}
          </View>
        </View>
        <Text variant="callout">
          {reason ??
            "You don't need to come. If the league sets a new date, it will appear in Calendar."}
        </Text>
        <View style={styles.cancelButtons}>
          <View style={styles.cancelButton}>
            <Button
              label="Message coach"
              variant="secondary"
              block
              onPress={() =>
                router.push({
                  pathname: '/messages/coach',
                  params: { fixtureId: fixture.id },
                } as Href)
              }
              testID="cancelled-message-coach"
            />
          </View>
          <View style={styles.cancelButton}>
            <Button label="See what's next" onPress={onNext} block testID="cancelled-next" />
          </View>
        </View>
      </View>
    </View>
  );
}

const useStyles = makeStyles(({ colors }) => ({
  card: {
    marginHorizontal: layout.gutter,
    borderRadius: radius.xl,
    ...continuousCorners,
    overflow: 'hidden',
  },
  photo: { position: 'relative' },
  art: { height: 196 },
  pill: {
    position: 'absolute',
    top: 14,
    left: 14,
    height: 28,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.floodlight,
  },
  pillLive: { backgroundColor: colors.floodlight },
  pillDot: { width: 7, height: 7, borderRadius: radius.pill, backgroundColor: colors.onFloodlight },
  pillText: { ...fonts.bold, fontSize: 13, lineHeight: 18, color: colors.onFloodlight },
  scrim: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.xl,
    paddingBottom: 14,
    gap: 2,
    backgroundColor: colors.scrimEnd,
  },
  eyebrow: { ...fonts.semibold, fontSize: 13, lineHeight: 18, color: colors.onMediaMuted },
  title: { ...type.title1, color: colors.onMedia },
  body: { paddingHorizontal: spacing.lg, paddingTop: 14, paddingBottom: spacing.lg, gap: 14 },
  facts: { flexDirection: 'row', gap: 10 },
  fact: { flex: 1, gap: 2 },
  factLabel: { ...fonts.semibold, fontSize: 12, lineHeight: 16, color: colors.textMuted },
  factValue: { ...tabular(type.title3), ...fonts.bold, color: colors.text },
  factSub: { ...type.footnote, color: colors.textMuted },
  actions: { flexDirection: 'row', gap: spacing.sm },
  action: { flex: 1 },
  blocked: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.page,
  },
  blockedText: { flex: 1 },
  bold: { ...fonts.bold, color: colors.warning },
  cancelHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    backgroundColor: colors.danger,
  },
  cancelHeadText: { ...fonts.bold, fontSize: 19, lineHeight: 24, color: colors.primaryText },
  cancelRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  cancelWords: { flex: 1, gap: 2 },
  // Handoff M 3g: "Message coach" (M 4d, proposed) beside "See what's next".
  cancelButtons: { flexDirection: 'row', gap: spacing.sm },
  cancelButton: { flex: 1 },
  struck: { textDecorationLine: 'line-through' },
}));
