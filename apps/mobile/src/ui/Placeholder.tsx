/**
 * Marks a screen that is part of the navigation shell but not built yet, naming its inventory id
 * so nobody mistakes it for a real SPK-UX-008 empty state.
 */
import { StyleSheet, Text, View } from 'react-native';
import { colors, spacing, type } from './theme';

export function Placeholder({
  screenId,
  title,
  purpose,
}: {
  screenId: string;
  title: string;
  purpose: string;
}) {
  return (
    <View style={styles.box} accessible accessibilityLabel={`${title}. Not built yet. ${purpose}`}>
      <Text style={styles.title} accessibilityRole="header">
        {title}
      </Text>
      <Text style={styles.body}>{purpose}</Text>
      <Text style={styles.caption}>Not built yet ({screenId}).</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    margin: spacing.lg,
    padding: spacing.lg,
    gap: spacing.sm,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: colors.border,
    borderRadius: 6,
  },
  title: { ...type.heading, color: colors.text },
  body: { ...type.body, color: colors.text },
  caption: { ...type.caption, color: colors.textMuted },
});
