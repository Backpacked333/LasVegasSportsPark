/**
 * Sign-in entry (SCR-C-01, SCR-C-02, §4.13). The managed identity provider is DEC-018 (Technical
 * lead/account owners, §5.2), so release builds say in plain words that signing in to the app is
 * not available yet and that the front desk can help, over the welcome artwork, with the way to
 * account recovery (SCR-C-02). The decision and its owner are in the "Details for support" fold
 * only (PA-11, SPK-UX-011 **Proposed**; ADR-008).
 *
 * Development builds offer the development sign-in instead (src/dev), or the demo sign-in when the
 * app config's `appMode` is `demo` (src/demo). Both are `null` outside `__DEV__`, so release bundles
 * contain neither (scripts/check-release-bundle.mjs).
 */
import { useRouter } from 'expo-router';
import { View } from 'react-native';
import { onboardingArtwork } from '../../artwork/manifest';
import { DemoSignIn } from '../../demo';
import { DevSignIn } from '../../dev';
import { useApp } from '../../providers/AppProviders';
import { Artwork } from '../../ui/Artwork';
import { Button } from '../../ui/Button';
import { Screen } from '../../ui/Screen';
import { SupportDetails } from '../../ui/SupportDetails';
import { Text } from '../../ui/Text';
import { layout, makeStyles, spacing } from '../../ui/theme';

/** What a release build says about signing in while DEC-018 is open. */
export const SIGN_IN_UNAVAILABLE =
  "Signing in to the app isn't available yet. The front desk can help.";

export function SignInScreen() {
  const router = useRouter();
  const { services } = useApp();
  const styles = useStyles();
  if (DemoSignIn && services.config.appMode === 'demo') return <DemoSignIn />;
  if (DevSignIn) return <DevSignIn />;
  return (
    <Screen>
      <View style={styles.page} testID="sign-in-unavailable">
        <Artwork source={onboardingArtwork.welcome} aspectRatio={4 / 3} testID="sign-in-art" />
        <Text variant="title1" heading>
          Sign in
        </Text>
        <Text variant="body">{SIGN_IN_UNAVAILABLE}</Text>
        <Button
          label="Recover an existing account"
          variant="secondary"
          onPress={() => router.push('/recovery')}
        />
        <SupportDetails decisions={['DEC-018']} owner="Technical lead/account owners" />
      </View>
    </Screen>
  );
}

const useStyles = makeStyles(() => ({
  page: { paddingHorizontal: layout.gutter, paddingTop: spacing.md, gap: spacing.lg },
}));
