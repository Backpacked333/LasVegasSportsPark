/**
 * Quick access to the facility pass (SCR-C-05) and the notification inbox (SCR-C-06) from the
 * header of every destination, without a permanent tab (SPK-UX-002).
 */
import { useRouter } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, MIN_TOUCH_SIZE, spacing, type } from '../ui/theme';

export function QuickAccess() {
  const router = useRouter();
  return (
    <View style={styles.row}>
      <HeaderLink
        label="Pass"
        accessibilityLabel="Facility pass"
        onPress={() => router.push('/pass')}
        testID="quick-pass"
      />
      <HeaderLink
        label="Inbox"
        accessibilityLabel="Notification inbox"
        onPress={() => router.push('/inbox')}
        testID="quick-inbox"
      />
    </View>
  );
}

function HeaderLink(props: {
  label: string;
  accessibilityLabel: string;
  onPress: () => void;
  testID: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel}
      onPress={props.onPress}
      hitSlop={8}
      style={styles.link}
      testID={props.testID}
    >
      <Text style={styles.text}>{props.label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: spacing.xs, paddingRight: spacing.sm },
  link: {
    minHeight: MIN_TOUCH_SIZE,
    minWidth: MIN_TOUCH_SIZE,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: spacing.sm,
  },
  text: { ...type.body, color: colors.primary, fontWeight: '600' },
});
