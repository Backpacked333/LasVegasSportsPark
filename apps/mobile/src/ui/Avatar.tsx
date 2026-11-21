/**
 * Avatars (ADR-008; redesign handoff Phase 0 "Avatar: photo → initials on person colour, optional
 * ring"): the person's photo when one is given (`photoUri`), otherwise their initials on a tint.
 * The tint is the person's household colour when the screen knows it (`personColor`, from
 * `src/ui/person-colors.ts`), else a tone from `avatarTones` keyed by the person's id, the same
 * everywhere (`avatarToneFor`). `ring` draws a ring in the person colour around it (chips on
 * Home, the child profile). The API stores no profile photos yet, so screens pass no `photoUri`
 * today and every avatar shows initials; the photo path is ready for when one exists.
 *
 * Accessibility (SPK-UX-009): an avatar's name is the person's name, read as an image. Where the
 * name is already written next to it (a row, a card) pass `decorative` and it is hidden, so the
 * name is not read twice. `AvatarStack` overlaps a few avatars with a "+N" for the rest and reads
 * every name, in order, as one element.
 */
import { Image } from 'expo-image';
import { useState } from 'react';
import { Text, View, type StyleProp, type ViewStyle } from 'react-native';
import {
  avatarToneFor,
  fonts,
  makeStyles,
  radius,
  useTheme,
  type AvatarTone,
  type PersonColor,
} from './theme';

export type AvatarSize = 'sm' | 'md' | 'lg';

const SIZES: Readonly<Record<AvatarSize, number>> = { sm: 28, md: 40, lg: 56 };

export interface AvatarPerson {
  name: string;
  /** Stable key for the tone (the person's id); the name when absent. */
  id?: string;
}

/**
 * Up to two initials: the first letters of the first and last words of the name. Brackets and
 * punctuation are not letters: "Mary-Jane O'Neil" is "MO". A name in brackets is the person's
 * own name beside a role word, so it wins: "You (Dev)" is "D", not "Y(".
 */
export function initialsFor(name: string): string {
  const inner = /\(([^)]*)\)/u.exec(name)?.[1];
  const source = inner && /[\p{L}\p{N}]/u.test(inner) ? inner : name;
  const words = source
    .split(/\s+/u)
    .map((word) => word.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter(Boolean);
  if (words.length === 0) return '?';
  const first = Array.from(words[0] ?? '')[0] ?? '';
  const last = words.length > 1 ? (Array.from(words[words.length - 1] ?? '')[0] ?? '') : '';
  return `${first}${last}`.toLocaleUpperCase();
}

export interface AvatarProps extends AvatarPerson {
  size?: AvatarSize | number;
  /** The name is written next to the avatar: hide it from screen readers. */
  decorative?: boolean;
  /** The person's household colour: the initials tint and the ring. */
  personColor?: PersonColor;
  /** A photo of the person; initials while it loads and if it fails. */
  photoUri?: string | null;
  /** A ring in the person colour (or the tone's text colour) around the avatar. */
  ring?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/** Ring width and the gap between the ring and the picture. */
const RING = 2;
const RING_GAP = 2;

export function Avatar({
  name,
  id,
  size = 'md',
  decorative = false,
  personColor,
  photoUri,
  ring = false,
  style,
  testID,
}: AvatarProps) {
  const theme = useTheme();
  const styles = useStyles();
  const [photoFailed, setPhotoFailed] = useState(false);
  const tone: AvatarTone = personColor
    ? { background: personColor.tint, foreground: personColor.onTint }
    : avatarToneFor(theme, id ?? name);
  const side = typeof size === 'number' ? size : SIZES[size];
  const inner = ring ? side - 2 * (RING + RING_GAP) : side;
  const showPhoto = !!photoUri && !photoFailed;
  return (
    <View
      style={[
        styles.avatar,
        { width: side, height: side },
        ring
          ? { borderWidth: RING, borderColor: personColor?.accent ?? tone.foreground }
          : { backgroundColor: tone.background },
        style,
      ]}
      accessible={!decorative}
      accessibilityRole={decorative ? undefined : 'image'}
      accessibilityLabel={decorative ? undefined : name}
      accessibilityElementsHidden={decorative}
      importantForAccessibility={decorative ? 'no-hide-descendants' : 'yes'}
      testID={testID}
    >
      <View
        style={[
          styles.avatar,
          { width: inner, height: inner, backgroundColor: tone.background, overflow: 'hidden' },
        ]}
      >
        {showPhoto ? (
          <Image
            source={{ uri: photoUri }}
            style={{ width: inner, height: inner }}
            contentFit="cover"
            accessible={false}
            onError={() => setPhotoFailed(true)}
            testID={testID ? `${testID}-photo` : undefined}
          />
        ) : (
          <Text
            style={[styles.initials, { color: tone.foreground, fontSize: inner * 0.4 }]}
            maxFontSizeMultiplier={1}
          >
            {initialsFor(name)}
          </Text>
        )}
      </View>
    </View>
  );
}

/**
 * How far each avatar in a stack slides over the one before it: a sixth of its width, so the next
 * circle (with its ring) stops short of the initials of the one before (two bold initials reach
 * about 78% of the way across the circle). It was a third, which cut the second letter.
 */
export function stackOverlap(side: number): number {
  return Math.round(side / 6);
}

/** The words of a stack: every name, in order ("Ava Lee, Ben Ortiz and Cara Diaz"). */
export function avatarStackLabel(people: readonly AvatarPerson[]): string {
  const names = people.map((p) => p.name);
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

export interface AvatarStackProps {
  people: readonly AvatarPerson[];
  /** How many avatars are drawn before "+N". */
  max?: number;
  size?: AvatarSize;
  /** Words read instead of the names (rare: the names are the default). */
  accessibilityLabel?: string;
  testID?: string;
}

export function AvatarStack({
  people,
  max = 3,
  size = 'sm',
  accessibilityLabel,
  testID,
}: AvatarStackProps) {
  const styles = useStyles();
  const shown = people.slice(0, max);
  const more = people.length - shown.length;
  const side = SIZES[size];
  return (
    <View
      style={styles.stack}
      accessible
      accessibilityRole="image"
      accessibilityLabel={accessibilityLabel ?? avatarStackLabel(people)}
      testID={testID}
    >
      {shown.map((person, index) => (
        <Avatar
          key={person.id ?? `${person.name}-${index}`}
          name={person.name}
          id={person.id}
          size={size}
          decorative
          style={[styles.ring, index > 0 && { marginLeft: -stackOverlap(side) }]}
        />
      ))}
      {more > 0 ? (
        <View
          style={[
            styles.avatar,
            styles.ring,
            styles.more,
            { width: side, height: side, marginLeft: -stackOverlap(side) },
          ]}
        >
          <Text style={[styles.moreText, { fontSize: side * 0.36 }]} maxFontSizeMultiplier={1}>
            +{more}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const useStyles = makeStyles(({ colors }) => ({
  avatar: { borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center' },
  initials: { ...fonts.bold },
  stack: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start' },
  // A ring in the page colour keeps overlapping avatars apart.
  ring: { borderWidth: 2, borderColor: colors.background },
  more: { backgroundColor: colors.surface },
  moreText: { ...fonts.bold, color: colors.text },
}));
