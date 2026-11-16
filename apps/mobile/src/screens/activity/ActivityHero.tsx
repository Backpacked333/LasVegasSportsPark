/**
 * The top of SCR-C-20 Activity or game detail (SPK-UX-004, SPK-COMMS-005, SPK-SCHED-008,
 * SPK-UX-009; ADR-008, PA-11): the activity's picture (`artworkFor`, decorative), its name as the
 * page's header, the key facts as tags (when, where, for whom, against whom), the status in its
 * journeys §3 phrase, the latest change as old and new details, the required action, and for a
 * game the RSVP (`RsvpControl`, passed in).
 *
 * The facts are one element for screen readers, read "For: … Against: … When: … Where: …", the
 * same words as the next-activity card (SCR-C-04); the tags draw them. Every control below keeps
 * the light surface it was designed for.
 */
import type { ReactNode } from 'react';
import { View } from 'react-native';
import { AVAILABILITY_REQUEST_ACTION } from '../../features/today/fixture-model';
import { ChangeDetails } from '../../features/today/ChangeDetails';
import { whenText, type ActivityCardModel } from '../../features/today/NextActivityCard';
import { Artwork, type ArtworkSource } from '../../ui/Artwork';
import { InfoCard } from '../../ui/InfoCard';
import { StatusBadge } from '../../ui/StatusBadge';
import { Tag } from '../../ui/Tag';
import { Text } from '../../ui/Text';
import {
  continuousCorners,
  elevation,
  layout,
  makeStyles,
  radius,
  spacing,
  useTheme,
} from '../../ui/theme';

export const PLACE_NOT_SHOWN = 'Place not shown yet';

/** The facts' one name, as the next-activity card reads them. */
export function factsLabel(model: ActivityCardModel): string {
  return [
    `For: ${model.participant}`,
    model.opponent ? `Against: ${model.opponent}` : null,
    `When: ${whenText(model)}`,
    `Where: ${model.location ?? PLACE_NOT_SHOWN}`,
  ]
    .filter(Boolean)
    .join('. ');
}

/** A required action in customer words (the shared constant still names a "fixture"). */
export function requiredActionText(action: string): string {
  return action === AVAILABILITY_REQUEST_ACTION
    ? 'Answer the availability request for this game.'
    : action;
}

export function ActivityHero({
  model,
  source,
  rsvp,
  testID,
}: {
  model: ActivityCardModel;
  source: ArtworkSource;
  /** The game's RSVP control; omitted for sessions. */
  rsvp?: ReactNode;
  testID: string;
}) {
  const theme = useTheme();
  const styles = useStyles();
  return (
    <View style={[elevation(theme, 'card'), styles.card]} testID={testID}>
      <Artwork source={source} aspectRatio={16 / 9} rounded={false} testID={`${testID}-art`} />
      <View style={styles.body}>
        <Text variant="title1" heading>
          {model.title}
        </Text>
        <View accessible accessibilityLabel={factsLabel(model)} style={styles.tags}>
          <Tag icon="schedule" label={whenText(model)} />
          <Tag icon="location_on" label={model.location ?? PLACE_NOT_SHOWN} />
          <Tag icon="person" label={`For ${model.participant}`} />
          {model.opponent ? <Tag icon="sports_soccer" label={`vs ${model.opponent}`} /> : null}
        </View>
        <StatusBadge {...model.status} testID={`${testID}-status`} />
        {model.change ? <ChangeDetails change={model.change} testID={`${testID}-change`} /> : null}
        {model.requiredAction ? (
          <InfoCard
            tone="warning"
            title="Action needed"
            message={requiredActionText(model.requiredAction)}
          />
        ) : null}
        {rsvp}
      </View>
    </View>
  );
}

const useStyles = makeStyles(({ colors }) => ({
  card: {
    marginHorizontal: layout.gutter,
    marginTop: spacing.sm,
    borderRadius: radius.lg,
    ...continuousCorners,
    overflow: 'hidden',
    backgroundColor: colors.background,
  },
  body: { padding: spacing.lg, gap: spacing.md },
  tags: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
}));
