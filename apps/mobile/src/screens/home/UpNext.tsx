/**
 * "Up next" on SCR-C-03 Home: the SCR-C-04 next activity as a hero `MediaCard` (SPK-UX-004,
 * SPK-COMMS-005, SPK-SCHED-008, SPK-UX-009; ADR-008).
 *
 * - The card is one element with one name: the activity, whom it is for, the opponent, when (with
 *   the zone), where and the status ("Lions vs Tigers. For: Sam (Lions). Against: Tigers. When:
 *   Sat, Oct 24, 9:00 AM to 10:30 AM MDT. Where: North Complex, Field 1. Scheduled"). It opens the
 *   activity or the game; its picture comes from `artworkFor`.
 * - Beside it, as their own elements: the change as old and new details, the required action, and
 *   for a game the inline "Going / Not going" answer (`RsvpInline`, the same requests as the RSVP
 *   control on the game screen).
 * - A time on the device's clock says so under the card (`zoneNotice`).
 */
import type { Schema } from '@sportspark/api-client';
import { useRouter, type Href } from 'expo-router';
import type { ReactNode } from 'react';
import { View } from 'react-native';
import { artworkFor } from '../../artwork/artworkFor';
import { ChangeDetails } from '../../features/today/ChangeDetails';
import {
  AVAILABILITY_REQUEST_ACTION,
  fixtureCardModel,
  fixtureRequiredAction,
  ownResponse,
  viewerOnRoster,
} from '../../features/today/fixture-model';
import { whenText, type ActivityCardModel } from '../../features/today/NextActivityCard';
import { latestChangeForEvent, openAvailabilityRequest } from '../../features/today/notices';
import { nameOf, useInbox } from '../../features/today/queries';
import { RsvpInline } from '../../features/today/RsvpInline';
import { sessionHref, useSessionActivity } from '../../features/today/session-activity';
import { zoneNotice } from '../../features/today/time';
import type { ArtworkSource } from '../../ui/Artwork';
import { InfoCard } from '../../ui/InfoCard';
import { MediaCard } from '../../ui/MediaCard';
import { Text } from '../../ui/Text';
import { layout, makeStyles, spacing } from '../../ui/theme';

type FamilyCalendarItem = Schema<'FamilyCalendarItem'>;
type FixtureDetail = Schema<'FixtureDetail'>;
type MyTeamEntry = Schema<'MyTeamEntry'>;
type Me = Schema<'Me'>;

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

function UpNextCard({
  model,
  source,
  onOpen,
  openHint,
  rsvp,
  zoneSample,
}: {
  model: ActivityCardModel;
  source: ArtworkSource;
  onOpen?: () => void;
  openHint: string;
  rsvp?: ReactNode;
  /** An instant to name the zone at when the activity has no start yet. */
  zoneSample: string;
}) {
  const styles = useStyles();
  const notice = zoneNotice(model.zone, model.start ?? zoneSample);
  const extras = Boolean(model.change || model.requiredAction || rsvp);
  return (
    <View style={styles.root}>
      <MediaCard
        form="hero"
        source={source}
        eyebrow={model.participant}
        title={model.title}
        meta={[
          ...(model.opponent ? [`Against ${model.opponent}`] : []),
          whenText(model),
          model.location ?? PLACE_NOT_SHOWN,
        ]}
        tags={[model.status.label]}
        onPress={onOpen}
        accessibilityLabel={heroLabel(model)}
        accessibilityHint={openHint}
        trailing={
          extras ? (
            <View style={styles.extras}>
              {model.change ? (
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
              {rsvp}
            </View>
          ) : undefined
        }
        testID="next-activity-card"
      />
      {notice ? (
        <Text variant="footnote" tone="muted">
          {notice}
        </Text>
      ) : null}
    </View>
  );
}

/** The next activity when it is a session or a booking from the family calendar. */
export function UpNextSession({
  item,
  names,
}: {
  item: FamilyCalendarItem;
  names: Map<string, string>;
}) {
  const router = useRouter();
  const { model, offering } = useSessionActivity(item, nameOf(names, item.personId));
  if (!model) return null;
  const href = sessionHref(item);
  const art = artworkFor(offering ?? { title: model.title }, 'wide');
  return (
    <UpNextCard
      model={model}
      source={art.source}
      zoneSample={item.start}
      onOpen={href ? () => router.push(href as Href) : undefined}
      openHint="Opens the activity details"
    />
  );
}

/** The next activity when it is a game of a team the person or their family is on (CMP-02). */
export function UpNextFixture({
  fixture,
  teams,
  names,
  me,
  onReload,
}: {
  fixture: FixtureDetail;
  teams: readonly MyTeamEntry[] | undefined;
  names: Map<string, string>;
  me: Me | undefined;
  onReload: () => void;
}) {
  const router = useRouter();
  const inbox = useInbox();
  const items = inbox.data?.items ?? [];
  const latest = latestChangeForEvent(items, fixture.schedulingEventId);
  const viewerId = me?.principal.personId ?? null;
  const requiredAction = fixtureRequiredAction(
    fixture,
    viewerId,
    openAvailabilityRequest(items, fixture.id),
  );
  const model = fixtureCardModel({
    fixture,
    teams,
    names,
    change: latest?.change ?? null,
    requiredAction,
  });
  const own = ownResponse(fixture, viewerId);
  const art = artworkFor({ kind: 'game', title: model.title }, 'wide');
  return (
    <UpNextCard
      model={model}
      source={art.source}
      onOpen={() => router.push({ pathname: '/fixtures/[id]', params: { id: fixture.id } } as Href)}
      openHint="Opens the game"
      zoneSample={fixture.createdAt}
      rsvp={
        // Keyed by fixture: when the next activity becomes another fixture, its answer and
        // revision never carry over from the previous one (CMP-04, §4.9).
        <RsvpInline
          key={fixture.id}
          fixtureId={fixture.id}
          fixtureStatus={fixture.status}
          myResponse={own?.state ?? fixture.myResponse ?? null}
          responseRevision={own?.revision ?? null}
          onRoster={viewerOnRoster(fixture)}
          onReload={onReload}
        />
      }
    />
  );
}

const useStyles = makeStyles(() => ({
  root: { paddingHorizontal: layout.gutter, gap: spacing.sm },
  extras: { flex: 1, gap: spacing.md, paddingTop: spacing.md },
}));
