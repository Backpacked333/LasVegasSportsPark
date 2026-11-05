/**
 * Demo sign-in for the customer app (development builds with appMode `demo` only): signs in as the
 * seeded parent through the API's local identity provider (`POST /v1/dev/tokens`) and starts the
 * family tour.
 */
import { presentationForError } from '@sportspark/api-client';
import { useRouter } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';
import { useApiCommand } from '../api/useApiCommand';
import { useApp } from '../providers/AppProviders';
import { Button } from '../ui/Button';
import { Screen } from '../ui/Screen';
import { StateView } from '../ui/StateView';
import { colors, spacing, type } from '../ui/theme';
import { setDemoState } from './store';
import { DEMO_PARENT_SUBJECT, FAMILY_TOUR } from './tour';

export function DemoSignInScreen() {
  const { signIn, services } = useApp();
  const router = useRouter();
  const mint = useApiCommand('post', '/dev/tokens');
  const accountId = services.config.demoAccounts?.[DEMO_PARENT_SUBJECT];

  const start = async () => {
    if (!accountId) return;
    try {
      const token = await mint.submit({ body: { accountId } });
      setDemoState({ active: true, step: 0, open: true });
      await signIn({ token: token.token, expiresAt: token.expiresAt, accountId: token.accountId });
      router.replace(FAMILY_TOUR[0]?.path ?? '/');
    } catch {
      // Rendered below from mint.error.
    }
  };

  return (
    <Screen>
      <View style={styles.body}>
        <Text style={styles.title} accessibilityRole="header">
          Demo mode
        </Text>
        <Text style={styles.text}>
          Sign in as a parent with sample data and take a short tour of the family app. Nothing here
          touches real people or real money.
        </Text>
        <Text style={styles.muted}>
          Staff roles such as front desk, league manager, coach and referee are demonstrated in the
          staff dashboard.
        </Text>
        {accountId ? null : (
          <StateView
            variant="unavailable"
            title="Demo accounts not set up"
            description="Start the demo with pnpm demo --mobile, which seeds the demo accounts and starts the API."
          />
        )}
        <Button
          label="Sign in as the parent"
          onPress={() => void start()}
          disabled={!accountId}
          busy={mint.isProcessing}
        />
        {mint.error ? (
          presentationForError(mint.error) === 'unavailable' ? (
            <StateView
              variant="unavailable"
              title="Demo sign-in not available"
              description="The API is not running in demo mode, or the demo database was reset. Restart with pnpm demo --mobile."
            />
          ) : (
            <StateView variant="error" error={mint.error} />
          )
        ) : null}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: { padding: spacing.lg, gap: spacing.md },
  title: { ...type.title, color: colors.text },
  text: { ...type.body, color: colors.text },
  muted: { ...type.caption, color: colors.textMuted },
});
