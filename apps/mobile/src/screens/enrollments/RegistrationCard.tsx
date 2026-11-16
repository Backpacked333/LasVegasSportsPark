/**
 * One registration as a card (SCR-C-32; PA-11, ADR-008 visual system v2): the activity's picture
 * (`artworkFor`, a square thumbnail, hidden from screen readers), the activity name, what kind of
 * registration it is with its dates, and its status in words (SPK-UX-004 phrases, word for word,
 * from `enrollmentStatus`). The whole card is one element: a button when it opens something, named
 * "Name, Detail, Status" as the rows before it were (SPK-UX-009).
 *
 * `registrationArt` picks the picture from what is known: the activity's kind when the public
 * offering was read, else the registration's own kind (a trial, pickup, membership, rental or
 * party), then words in the name (futsal, basketball, mini) by `artworkFor`'s own rules.
 */
import type { Schema } from '@sportspark/api-client';
import { View } from 'react-native';
import { artworkFor, type ArtworkSubject } from '../../artwork/artworkFor';
import { Artwork } from '../../ui/Artwork';
import { Card } from '../../ui/Card';
import { StatusBadge, type StatusBadgeProps } from '../../ui/StatusBadge';
import { Text } from '../../ui/Text';
import { makeStyles, radius, spacing } from '../../ui/theme';

type Enrollment = Schema<'Enrollment'>;

/** The offering kind a registration's own kind implies, when the activity was not read. */
const INTENT_KINDS: Partial<Record<Enrollment['intent'], string>> = {
  trial: 'trial',
  pickup: 'pickup',
  makeup: 'session',
  membership: 'membership',
  rental_request: 'rental',
  party_request: 'party',
  youth: 'season',
  individual_league: 'league',
  join_team: 'team',
  create_team_entry: 'team_entry',
};

export function registrationArt(
  intent: Enrollment['intent'] | null,
  name: string,
  offering?: { kind?: string | null; ageBand?: ArtworkSubject['ageBand'] } | null,
  shape: 'square' | 'wide' = 'square',
) {
  return artworkFor(
    {
      kind: offering?.kind ?? (intent ? INTENT_KINDS[intent] : null) ?? null,
      name,
      ageBand: offering?.ageBand ?? null,
      // A youth program without its age band still reads as youth.
      ...(intent === 'youth' && !offering?.ageBand ? { ageMax: 12 } : {}),
    },
    shape,
  ).source;
}

export function RegistrationCard({
  title,
  detail,
  status,
  art,
  onPress,
  accessibilityHint,
  testID,
}: {
  title: string;
  detail?: string;
  status: Pick<StatusBadgeProps, 'tone' | 'label'>;
  art: ReturnType<typeof registrationArt>;
  onPress?: () => void;
  accessibilityHint?: string;
  testID?: string;
}) {
  const styles = useStyles();
  const label = [title, detail, status.label].filter(Boolean).join(', ');
  return (
    <Card
      onPress={onPress}
      accessibilityLabel={onPress ? label : undefined}
      accessibilityHint={accessibilityHint}
      testID={testID}
    >
      <View
        style={styles.row}
        accessible={!onPress}
        accessibilityLabel={onPress ? undefined : label}
      >
        <Artwork source={art} aspectRatio={1} rounded style={styles.thumb} />
        <View style={styles.words}>
          <Text variant="headline">{title}</Text>
          {detail ? (
            <Text variant="caption" tone="muted">
              {detail}
            </Text>
          ) : null}
          <StatusBadge tone={status.tone} label={status.label} />
        </View>
      </View>
    </Card>
  );
}

const useStyles = makeStyles(() => ({
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  thumb: { width: 64, borderRadius: radius.md },
  words: { flex: 1, gap: spacing.xs, alignItems: 'flex-start' },
}));
