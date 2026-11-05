/**
 * Sign-in entry (SCR-C-01, SCR-C-02, §4.13). The managed identity provider is DEC-018 (Technical
 * lead/account owners, §5.2), so production builds show the pending state, with the way to account
 * recovery (SCR-C-02). Development builds offer the development sign-in instead (src/dev), which
 * production bundles do not contain.
 */
import { useRouter } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import { DevSignIn } from '../../dev';
import { Button } from '../../ui/Button';
import { Screen } from '../../ui/Screen';
import { StateView } from '../../ui/StateView';
import { spacing } from '../../ui/theme';

export function SignInScreen() {
  const router = useRouter();
  if (DevSignIn) return <DevSignIn />;
  return (
    <Screen>
      <StateView
        variant="pending-decision"
        subject="Account sign-in"
        decisions={['DEC-018']}
        owner="Technical lead/account owners"
      />
      <View style={styles.actions}>
        <Button
          label="Recover an existing account"
          variant="secondary"
          onPress={() => router.push('/recovery')}
        />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  actions: { paddingHorizontal: spacing.lg },
});
