/**
 * The two card forms of Explore (redesign handoff 1d; ADR-008 visual system v2):
 *
 * - `PickedCard`: a 4:5 picture tile in the "Picked for Maya" row, the promotion as a floodlight
 *   tag on the picture (not a separate section), the name, dates and time, and "$145 / week · 6
 *   left" on the scrim.
 * - `ActivityRow`: a white row with a square picture, the name, when it meets ("Wednesdays 5:00 PM
 *   · 8 weeks"), one fit answer (✓ fits, ▲ clashes, ✕ full · waitlist) and the price; "3 left"
 *   beside it when five or fewer places are left.
 *
 * Each card is one button whose name says everything on it (SPK-UX-009); pictures are decorative.
 */
import type { Schema } from '@sportspark/api-client';
import { Pressable, View } from 'react-native';
import { artworkFor } from '../../artwork/artworkFor';
import type { FitAnswer } from '../../features/register/fit';
import { Artwork } from '../../ui/Artwork';
import { MediaScrim } from '../../ui/MediaCard';
import { StatusBadge, type StatusBadgeProps } from '../../ui/StatusBadge';
import { Text } from '../../ui/Text';
import {
  elevation,
  fonts,
  makeStyles,
  radius,
  spacing,
  tabularFigures,
  useTheme,
} from '../../ui/theme';

type PublicOffering = Schema<'PublicOffering'>;

export interface CardFacts {
  name: string;
  /** "Wednesdays 5:00 PM · 8 weeks" or the dates. */
  when: string;
  price: string | null;
  fit: FitAnswer | null;
  places: StatusBadgeProps | null;
  /** The promotion's name ("Multi-week"), drawn as the floodlight tag. */
  promotion: string | null;
}

function cardLabel(facts: CardFacts): string {
  return [
    facts.name,
    facts.when,
    facts.price,
    facts.fit?.badge.label,
    facts.places && facts.fit?.kind !== 'full' ? facts.places.label : null,
    facts.promotion ? `Offer: ${facts.promotion}` : null,
  ]
    .filter(Boolean)
    .join(', ');
}

export function PickedCard({
  offering,
  facts,
  width,
  onPress,
  testID,
}: {
  offering: PublicOffering;
  facts: CardFacts;
  width: number;
  onPress: () => void;
  testID?: string;
}) {
  const styles = useStyles();
  const theme = useTheme();
  const priceLine = [
    facts.price,
    facts.places && facts.fit?.kind !== 'full' ? facts.places.label : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={cardLabel(facts)}
      accessibilityHint="Opens the activity"
      onPress={onPress}
      style={({ pressed }) => [
        styles.picked,
        elevation(theme, 'card'),
        { width },
        pressed ? styles.pressed : null,
      ]}
      testID={testID}
    >
      <Artwork source={artworkFor(offering, 'wide').source} aspectRatio={4 / 5} rounded={false} />
      {facts.promotion ? (
        <View style={styles.promo}>
          <Text style={styles.promoText} numberOfLines={1}>
            {facts.promotion}
          </Text>
        </View>
      ) : null}
      <MediaScrim fadeHeight={48}>
        <Text variant="title3" tone="onMedia" numberOfLines={2}>
          {facts.name}
        </Text>
        <Text variant="caption" tone="onMediaMuted" numberOfLines={1}>
          {facts.when}
        </Text>
        {priceLine ? (
          <Text variant="callout" tone="onMedia" style={styles.bold} tabular>
            {priceLine}
          </Text>
        ) : null}
      </MediaScrim>
    </Pressable>
  );
}

export function ActivityRow({
  offering,
  facts,
  onPress,
  testID,
}: {
  offering: PublicOffering;
  facts: CardFacts;
  onPress: () => void;
  testID?: string;
}) {
  const styles = useStyles();
  const theme = useTheme();
  const showPlaces = facts.places !== null && facts.fit?.kind !== 'full';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={cardLabel(facts)}
      accessibilityHint="Opens the activity"
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        elevation(theme, 'card'),
        pressed ? styles.pressed : null,
      ]}
      testID={testID}
    >
      <Artwork
        source={artworkFor(offering, 'square').source}
        aspectRatio={1}
        style={styles.thumb}
      />
      <View style={styles.rowWords}>
        <Text style={styles.rowTitle} numberOfLines={2}>
          {facts.name}
        </Text>
        <Text variant="footnote" tone="muted" numberOfLines={2}>
          {facts.when}
        </Text>
        <View style={styles.badges}>
          {facts.fit ? (
            <View style={styles.badge}>
              <StatusBadge {...facts.fit.badge} />
            </View>
          ) : null}
          {showPlaces && facts.places ? (
            <View style={styles.badge}>
              <StatusBadge {...facts.places} />
            </View>
          ) : null}
        </View>
      </View>
      {facts.price ? (
        <Text style={styles.price} tabular>
          {facts.price}
        </Text>
      ) : null}
    </Pressable>
  );
}

const useStyles = makeStyles(({ colors }) => ({
  picked: {
    borderRadius: radius.lg,
    overflow: 'hidden',
    backgroundColor: colors.background,
    borderCurve: 'continuous',
  },
  pressed: { opacity: 0.85 },
  promo: {
    position: 'absolute',
    top: spacing.md,
    left: spacing.md,
    maxWidth: '80%',
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: radius.pill,
    backgroundColor: colors.floodlight,
  },
  promoText: { ...fonts.bold, fontSize: 12, lineHeight: 16, color: colors.onFloodlight },
  bold: { ...fonts.bold },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.sm,
    borderRadius: radius.lg,
    backgroundColor: colors.background,
    borderCurve: 'continuous',
  },
  thumb: { width: 72, borderRadius: 14 },
  rowWords: { flex: 1, gap: 3 },
  rowTitle: { ...fonts.semibold, fontSize: 16, lineHeight: 21, color: colors.text },
  badges: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  badge: { maxWidth: '100%', flexShrink: 1 },
  price: {
    ...fonts.bold,
    ...tabularFigures,
    fontSize: 16,
    lineHeight: 21,
    color: colors.text,
    paddingRight: spacing.sm,
  },
}));
