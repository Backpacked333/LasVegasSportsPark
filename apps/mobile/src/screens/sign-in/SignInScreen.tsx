/**
 * Sign-in entry (SCR-C-01, SCR-C-02, §4.13). A build that names an identity provider
 * (`SPORTSPARK_AUTH_ISSUER`, `SPORTSPARK_AUTH_CLIENT_ID`) offers managed sign-in
 * (ManagedSignInView). Which provider that is remains DEC-018 (Technical lead/account owners,
 * §5.2), so a build that names none shows the pending state, with the way to account recovery
 * (SCR-C-02). Development builds without a provider offer the development sign-in instead
 * (src/dev), which production bundles do not contain.
 */
import { useRouter } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import { DevSignIn } from '../../dev';
import { useApp } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { Screen } from '../../ui/Screen';
import { StateView } from '../../ui/StateView';
import { spacing } from '../../ui/theme';
import { ManagedSignInView } from './ManagedSignInView';

export function SignInScreen() {
  const router = useRouter();
  const { services, session } = useApp();
  const managedSignIn = services.managedSignIn ?? null;
  if (managedSignIn) {
    return (
      <Screen>
        <ManagedSignInView managedSignIn={managedSignIn} expired={session.expired} />
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
