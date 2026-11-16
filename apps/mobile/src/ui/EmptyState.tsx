/**
 * EmptyState: what a screen shows when it has nothing yet (SPK-UX-008 empty), with an illustration
 * (ADR-008): the artwork, a title (a header for screen readers), a message saying what would
 * appear here and how, and an optional action to start. The artwork is decorative (`Artwork`), so
 * screen readers hear the words only.
 *
 * `source` is passed by the screen (from the artwork manifest); without one the state is words
 * only. For loading, failures and the other states, use `StateView`.
 *
 * `announce`: the state answers something the person did or waited for (a list that came back
 * empty), so it is a live region: TalkBack reads it as it appears, and VoiceOver hears the title,
 * the message and the action's label (`ui/announce`), the same words `StateView`'s empty state
 * announces (SPK-UX-008, SPK-UX-009).
 */
import { Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { LiveRegion, sentences } from './announce';
import { Artwork, type ArtworkSource } from './Artwork';
import { Button } from './Button';
import { layout, makeStyles, spacing, type } from './theme';

export interface EmptyStateProps {
  source?: ArtworkSource;
  title: string;
  message: string;
  action?: { label: string; onPress: () => void; accessibilityHint?: string };
  /** A live region announced when it appears (an answer, not a placeholder). */
  announce?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function EmptyState({
  source,
  title,
  message,
  action,
  announce = false,
  style,
  testID,
}: EmptyStateProps) {
  const body = <EmptyBody source={source} title={title} message={message} action={action} />;
  const styles = useStyles();
  return announce ? (
    <LiveRegion
      style={[styles.root, style]}
      announcement={sentences(title, message, action?.label)}
      testID={testID}
    >
      {body}
    </LiveRegion>
  ) : (
    <View style={[styles.root, style]} testID={testID}>
      {body}
    </View>
  );
}

function EmptyBody({
  source,
  title,
  message,
  action,
}: Pick<EmptyStateProps, 'source' | 'title' | 'message' | 'action'>) {
  const styles = useStyles();
  return (
    <>
      {source ? (
        <Artwork source={source} aspectRatio={1} contentFit="contain" style={styles.art} />
      ) : null}
      <Text style={styles.title} accessibilityRole="header">
        {title}
      </Text>
      <Text style={styles.message}>{message}</Text>
      {action ? (
        <Button
          label={action.label}
          onPress={action.onPress}
          accessibilityHint={action.accessibilityHint}
        />
      ) : null}
    </>
  );
}

const useStyles = makeStyles(({ colors }) => ({
  root: {
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: layout.gutter,
    paddingVertical: spacing.xl,
  },
  // Transparent illustrations: no placeholder fill behind them.
  art: { width: '60%', maxWidth: 240, backgroundColor: 'transparent' },
  title: { ...type.title, color: colors.text, textAlign: 'center' },
  message: { ...type.body, color: colors.textMuted, textAlign: 'center' },
}));
