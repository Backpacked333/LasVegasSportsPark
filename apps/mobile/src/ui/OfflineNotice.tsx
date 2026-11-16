/**
 * A command that needs a connection while the device is offline (SPK-UX-008, §4.15), in the
 * visual system v2 (ADR-008, **Proposed**): a "Needs a connection" badge (glyph and words, never
 * colour alone; SPK-UX-009) and what happens to the person's entries. Nothing is queued: the
 * screen keeps what was typed. Read by screen readers as one element, "{what} needs a connection".
 *
 * Moved here from `features/teams/ui.tsx`; the teams kit re-exports it.
 */
import { View } from 'react-native';
import { StatusBadge } from './StatusBadge';
import { Text } from './Text';
import { makeStyles, spacing } from './theme';

export interface OfflineNoticeProps {
  /** What needs the connection, as the start of a sentence ("Sending the invitation"). */
  what: string;
  testID?: string;
}

export function OfflineNotice({ what, testID }: OfflineNoticeProps) {
  const styles = useStyles();
  return (
    <View
      style={styles.notice}
      accessible
      accessibilityLabel={`${what} needs a connection`}
      testID={testID}
    >
      <StatusBadge tone="warning" label="Needs a connection" />
      <Text variant="body">
        {`${what} needs a connection. Nothing is queued: your entries are kept on this screen.`}
      </Text>
    </View>
  );
}

const useStyles = makeStyles(() => ({
  notice: { gap: spacing.xs, paddingVertical: spacing.xs },
}));
