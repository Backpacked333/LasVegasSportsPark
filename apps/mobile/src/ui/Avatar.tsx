/**
 * Initials avatars (ADR-008): a person's initials on a tint from `avatarTones`, the same tone for
 * the same person everywhere (`avatarToneFor`, keyed by the person's id). Initials only: the app
 * shows no photos of people.
 *
 * Accessibility (SPK-UX-009): an avatar's name is the person's name, read as an image. Where the
 * name is already written next to it (a row, a card) pass `decorative` and it is hidden, so the
 * name is not read twice. `AvatarStack` overlaps a few avatars with a "+N" for the rest and reads
 * every name, in order, as one element.
 */
import { Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { avatarToneFor, fonts, makeStyles, radius, useTheme } from './theme';

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
  size?: AvatarSize;
  /** The name is written next to the avatar: hide it from screen readers. */
  decorative?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function Avatar({ name, id, size = 'md', decorative = false, style, testID }: AvatarProps) {
  const theme = useTheme();
  const styles = useStyles();
  const tone = avatarToneFor(theme, id ?? name);
  const side = SIZES[size];
  return (
    <View
      style={[
        styles.avatar,
        { width: side, height: side, backgroundColor: tone.background },
        style,
      ]}
      accessible={!decorative}
      accessibilityRole={decorative ? undefined : 'image'}
      accessibilityLabel={decorative ? undefined : name}
      accessibilityElementsHidden={decorative}
      importantForAccessibility={decorative ? 'no-hide-descendants' : 'yes'}
      testID={testID}
    >
      <Text
        style={[styles.initials, { color: tone.foreground, fontSize: side * 0.4 }]}
        maxFontSizeMultiplier={1}
      >
        {initialsFor(name)}
      </Text>
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
