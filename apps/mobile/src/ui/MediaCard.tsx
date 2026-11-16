/**
 * MediaCard: an activity, a team or a place as a card with its picture (ADR-008), in three forms:
 *
 * - `hero`: a wide picture across the screen with the words over its lower part (Home, Explore).
 * - `tile`: a smaller picture card for a `Carousel` (give it a `width`).
 * - `compact`: a square thumbnail beside the words, for lists.
 *
 * Each is one focusable element for screen readers (SPK-UX-009) with one name, read eyebrow,
 * title, meta lines, tags ("Fall league, U10 Saturday league, Saturdays 9 am, Ages 9 to 10"); a
 * button when it opens something. The picture is decorative (`Artwork`). The `trailing` slot (a
 * small action, such as a save button) sits beside the card's element, never inside it, so it
 * stays its own control.
 *
 * Words over a picture sit only on the scrim (`MediaScrim`, also used by Home's greeting band): a
 * gradient from `scrimStart` (clear) into `scrimEnd`, drawn with expo-linear-gradient, then a band
 * of `scrimEnd` under the text, which keeps `onMedia` and `onMediaMuted` at 4.5:1 over any pixel
 * (theme test). The text only ever sits on the `scrimEnd` part; the fade above it has no hard edge. At large text sizes (font scale 1.3 and above) the words move below the
 * picture, in the page's own text colours, so nothing is clipped or crowded over the image.
 *
 * Pressed, the card shrinks slightly (`PressableScale`) only when motion is not reduced and always
 * dims a little.
 */
import { LinearGradient } from 'expo-linear-gradient';
import type { ReactNode } from 'react';
import { Text, useWindowDimensions, View, type StyleProp, type ViewStyle } from 'react-native';
import { Artwork, type ArtworkSource } from './Artwork';
import { useMotion } from './motion';
import { PressableScale } from './PressableScale';
import { Tag } from './Tag';
import {
  continuousCorners,
  elevation,
  fonts,
  makeStyles,
  MIN_TOUCH_SIZE,
  motionTokens,
  radius,
  spacing,
  type,
  useTheme,
} from './theme';

export type MediaCardForm = 'hero' | 'tile' | 'compact';

/** Height of the fade above the words: tall enough that the scrim never shows a step. */
export const SCRIM_FADE_HEIGHT = 56;

/**
 * The scrim under words over a picture, laid at the bottom of the picture: a smooth fade from
 * `scrimStart` to `scrimEnd`, then the words on `scrimEnd`. Decorative: draws no element of its
 * own for screen readers.
 */
export function MediaScrim({
  children,
  fadeHeight = SCRIM_FADE_HEIGHT,
  bandStyle,
  testID,
}: {
  children: ReactNode;
  fadeHeight?: number;
  bandStyle?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  const theme = useTheme();
  const styles = useStyles();
  return (
    <View style={styles.overlay} pointerEvents="box-none">
      <LinearGradient
        colors={[theme.colors.scrimStart, theme.colors.scrimEnd]}
        style={{ height: fadeHeight }}
        pointerEvents="none"
      />
      <View style={[styles.band, bandStyle]} testID={testID}>
        {children}
      </View>
    </View>
  );
}

/** From this font scale up, the words go below the picture instead of over it. */
export const LARGE_TEXT_SCALE = 1.3;

/** Where the words of a hero or tile go at a font scale. A compact card always has them beside. */
export function mediaTextPlacement(fontScale: number): 'over' | 'below' {
  return fontScale >= LARGE_TEXT_SCALE ? 'below' : 'over';
}

/** The card's one name: eyebrow, title, meta lines, tags, in that order. */
export function mediaCardLabel(parts: {
  eyebrow?: string;
  title: string;
  meta?: readonly string[];
  tags?: readonly string[];
}): string {
  return [parts.eyebrow, parts.title, ...(parts.meta ?? []), ...(parts.tags ?? [])]
    .filter((p): p is string => typeof p === 'string' && p.trim() !== '')
    .join(', ');
}

const ASPECT: Readonly<Record<MediaCardForm, number>> = { hero: 4 / 3, tile: 4 / 5, compact: 1 };

export interface MediaCardProps {
  form: MediaCardForm;
  source: ArtworkSource;
  title: string;
  eyebrow?: string;
  /** Short lines under the title ("Saturdays 9 am", "Pitch 2"). */
  meta?: readonly string[];
  /** Short labels drawn as tags ("Ages 9 to 10"). */
  tags?: readonly string[];
  /** A small control beside the card (its own element). */
  trailing?: ReactNode;
  onPress?: () => void;
  /** The card's name; built from its words by default. */
  accessibilityLabel?: string;
  accessibilityHint?: string;
  /** The picture's width divided by its height. */
  aspectRatio?: number;
  /** Width of a tile (in a carousel). */
  width?: number;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function MediaCard({
  form,
  source,
  title,
  eyebrow,
  meta = [],
  tags = [],
  trailing,
  onPress,
  accessibilityLabel,
  accessibilityHint,
  aspectRatio,
  width,
  style,
  testID,
}: MediaCardProps) {
  const theme = useTheme();
  const styles = useStyles();
  const motion = useMotion();
  const { fontScale } = useWindowDimensions();
  const compact = form === 'compact';
  const placement = compact ? 'below' : mediaTextPlacement(fontScale);
  const onMedia = placement === 'over';
  const label = accessibilityLabel ?? mediaCardLabel({ eyebrow, title, meta, tags });

  const words = (
    <View style={[styles.words, compact && styles.compactWords]}>
      {eyebrow ? (
        <Text style={[styles.eyebrow, onMedia ? styles.eyebrowOnMedia : null]}>{eyebrow}</Text>
      ) : null}
      <Text
        style={[form === 'hero' ? styles.heroTitle : styles.title, onMedia ? styles.onMedia : null]}
      >
        {title}
      </Text>
      {meta.map((line) => (
        <Text key={line} style={[styles.meta, onMedia ? styles.metaOnMedia : null]}>
          {line}
        </Text>
      ))}
      {tags.length > 0 ? (
        <View style={styles.tags}>
          {tags.map((tag) => (
            <Tag key={tag} label={tag} tone={onMedia ? 'onMedia' : 'neutral'} />
          ))}
        </View>
      ) : null}
    </View>
  );

  const picture = (
    <Artwork
      source={source}
      aspectRatio={aspectRatio ?? ASPECT[form]}
      rounded={compact}
      style={compact ? styles.thumb : null}
    />
  );

  const body = compact ? (
    <>
      {picture}
      {words}
    </>
  ) : onMedia ? (
    <View>
      {picture}
      <MediaScrim testID={testID ? `${testID}-scrim` : undefined}>{words}</MediaScrim>
    </View>
  ) : (
    <>
      {picture}
      <View style={styles.below}>{words}</View>
    </>
  );

  const mainStyle = compact ? styles.compactMain : styles.main;
  // PressableScale springs the card to the press scale while motion is on; the pressed style
  // names the same scale (what the card settles at), and the animated style drawn after it wins.
  const main = onPress ? (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      onPress={onPress}
      style={({ pressed }) => [
        mainStyle,
        pressed && styles.pressed,
        pressed && !motion.reduced && styles.scaled,
      ]}
    >
      {body}
    </PressableScale>
  ) : (
    <View style={mainStyle} accessible accessibilityLabel={label}>
      {body}
    </View>
  );

  return (
    <View
      style={[
        elevation(theme, 'card'),
        styles.card,
        compact ? styles.compactCard : null,
        width !== undefined ? { width } : null,
        style,
      ]}
      testID={testID}
    >
      {main}
      {trailing ? (
        <View style={compact ? styles.compactTrailing : styles.trailing}>{trailing}</View>
      ) : null}
    </View>
  );
}

const useStyles = makeStyles(({ colors }) => ({
  card: { borderRadius: radius.lg, ...continuousCorners, overflow: 'hidden' },
  compactCard: { flexDirection: 'row', alignItems: 'center', padding: spacing.sm },
  main: { minHeight: MIN_TOUCH_SIZE },
  compactMain: {
    flex: 1,
    minHeight: MIN_TOUCH_SIZE,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  pressed: { opacity: 0.88 },
  scaled: { transform: [{ scale: motionTokens.pressScale }] },
  thumb: { width: 72 },
  overlay: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  band: {
    backgroundColor: colors.scrimEnd,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.lg,
  },
  below: { padding: spacing.lg },
  words: { gap: spacing.xxs },
  compactWords: { flex: 1 },
  eyebrow: { ...type.footnote, ...fonts.semibold, color: colors.textMuted },
  eyebrowOnMedia: { color: colors.onMediaMuted },
  heroTitle: { ...type.title1, color: colors.text },
  title: { ...type.title3, color: colors.text },
  onMedia: { color: colors.onMedia },
  meta: { ...type.callout, color: colors.textMuted },
  metaOnMedia: { color: colors.onMediaMuted },
  tags: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, marginTop: spacing.xs },
  trailing: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
  },
  compactTrailing: { marginLeft: spacing.sm },
}));
