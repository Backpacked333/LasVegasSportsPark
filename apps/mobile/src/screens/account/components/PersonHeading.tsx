/**
 * A person's name over their records (SCR-C-30 forms, SCR-C-31 family; PA-11, ADR-008 visual
 * system v2): their initials (`Avatar`, hidden from screen readers) beside the name, announced as
 * a header so people can move from person to person (SPK-UX-009). The name is read once, as the
 * header; the avatar adds nothing a screen reader would say.
 */
import { View } from 'react-native';
import { Avatar } from '../../../ui/Avatar';
import { Text } from '../../../ui/Text';
import { makeStyles, spacing } from '../../../ui/theme';

export function PersonHeading({
  name,
  personId,
  detail,
  testID,
}: {
  name: string;
  personId?: string;
  /** A line under the name ("You", "Child"). */
  detail?: string;
  testID?: string;
}) {
  const styles = useStyles();
  return (
    <View style={styles.row} testID={testID}>
      <Avatar name={name} id={personId} decorative />
      <View style={styles.words}>
        <Text variant="title3" heading>
          {name}
        </Text>
        {detail ? (
          <Text variant="footnote" tone="muted">
            {detail}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

const useStyles = makeStyles(() => ({
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  words: { flex: 1, gap: spacing.xxs },
}));
