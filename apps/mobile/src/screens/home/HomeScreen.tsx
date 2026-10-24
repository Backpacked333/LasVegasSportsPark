/**
 * SCR-C-03 Home (SPK-UX-002, SPK-UX-003). Shell only: the prioritised sections (urgent changes,
 * next activity SCR-C-04, required actions, invitations and offers, results, renewals) are built
 * by the screen groups that own them. Quick access to the pass and the inbox is here and in every
 * destination's header.
 */
import { useRouter } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import { RequireSession } from '../../session/RequireSession';
import { Button } from '../../ui/Button';
import { Placeholder } from '../../ui/Placeholder';
import { Screen } from '../../ui/Screen';
import { spacing } from '../../ui/theme';

export function HomeScreen() {
  const router = useRouter();
  return (
    <Screen>
      <View style={styles.quick}>
        <Button
          label="Show facility pass"
          onPress={() => router.push('/pass')}
          testID="home-pass"
        />
        <Button
          label="Open notifications"
          variant="secondary"
          onPress={() => router.push('/inbox')}
          testID="home-inbox"
        />
      </View>
      <RequireSession what="your next activity and the actions you need to take">
        <Placeholder
          screenId="SCR-C-03, SCR-C-04"
          title="Today and next"
          purpose="Urgent changes, your next activity, actions required before participation, invitations and offers, results, renewals, in that order (SPK-UX-003)."
        />
      </RequireSession>
    </Screen>
  );
}

const styles = StyleSheet.create({
  quick: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, padding: spacing.lg },
});
