/**
 * Managed customer sign-in (SCR-C-01, SCR-C-02; SPK-UX-001, §4.13, §4.14; DEC-018). One button
 * opens the identity provider's page in the system sign-in browser. After the provider verifies
 * the person, the app finds their login account or, on a first sign-in, registers one
 * (`POST /v1/accounts/register`, which gives no access), then opens Home, or account setup when
 * the account has no participant record yet (SPK-IAM-002).
 *
 * States (SPK-UX-008): ready; processing; offline (button disabled); closed without signing in
 * (said plainly, nothing changed); recovery required (the answer did not belong to this attempt,
 * or the provider was unreachable: try again); permission restriction (verified, but no account
 * and this build names no organization to register in).
 */
import { ApiError, OidcError, type Session } from '@sportspark/api-client';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useApp, useConnectivity } from '../../providers/AppProviders';
import type { ManagedSignIn } from '../../session/managed-sign-in';
import { LiveText } from '../../ui/announce';
import { Button } from '../../ui/Button';
import { StateView } from '../../ui/StateView';
import { colors, spacing, type } from '../../ui/theme';

type Problem = { kind: 'message'; text: string } | { kind: 'api'; error: ApiError };

const NOTHING_CHANGED = 'Nothing was changed. Try again.';

function describe(error: unknown): Problem {
  if (error instanceof ApiError) {
    return error.code === 'AUTHENTICATION_REQUIRED'
      ? {
          kind: 'message',
          text: 'You signed in, but no account here matches. Ask the front desk to set up your account.',
        }
      : { kind: 'api', error };
  }
  if (error instanceof OidcError && error.code === 'provider_unavailable') {
    return {
      kind: 'message',
      text: `The sign-in service could not be reached. ${NOTHING_CHANGED}`,
    };
  }
  if (error instanceof OidcError && error.code === 'sign_in_refused') {
    return { kind: 'message', text: `Sign-in was cancelled or refused. ${NOTHING_CHANGED}` };
  }
  return { kind: 'message', text: `This sign-in could not be completed. ${NOTHING_CHANGED}` };
}

export function ManagedSignInView({
  managedSignIn,
  expired = false,
}: {
  managedSignIn: ManagedSignIn;
  expired?: boolean;
}) {
  const { services, api, signIn } = useApp();
  const { reachable } = useConnectivity();
  const offline = reachable === false;
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const organizationSlug = services.config.organizationSlug ?? null;

  const start = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const tokens = await managedSignIn.signIn();
      if (!tokens) {
        setProblem({ kind: 'message', text: 'Sign-in was closed before it finished.' });
        return;
      }
      const session: Session = {
        token: tokens.bearerToken,
        expiresAt: tokens.expiresAt,
        accountId: null,
        refreshToken: tokens.refreshToken,
      };
      // Stored first so the request below carries the token; cleared again if it fails.
      await services.sessionStore.save(session);
      let linked: boolean;
      try {
        if (organizationSlug) {
          const body = { organizationSlug };
          const account = await api.post('/accounts/register', {
            body,
            intent: api.intentTracker().current({ body }),
          });
          session.accountId = account.id;
          linked = account.personId !== null;
        } else {
          const me = await api.get('/me');
          session.accountId = me.principal.accountId;
          linked = me.person !== null;
        }
      } catch (error) {
        await services.sessionStore.clear();
        throw error;
      }
      await signIn(session);
      router.replace(linked ? '/' : '/onboarding');
    } catch (error) {
      setProblem(describe(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.panel}>
      <Text style={styles.title} accessibilityRole="header">
        Sign in
      </Text>
      <Text style={styles.body}>
        {expired
          ? 'Your session ended. Sign in again to continue.'
          : 'You sign in on the sign-in service’s page, then come back to the app. New here? The same button creates your account.'}
      </Text>
      <Button
        label="Continue to sign-in"
        onPress={() => void start()}
        busy={busy}
        disabled={offline}
        accessibilityHint={offline ? 'Needs a connection' : 'Opens the sign-in page'}
      />
      {offline ? <Text style={styles.body}>Signing in needs a connection.</Text> : null}
      {problem?.kind === 'message' ? (
        <LiveText style={styles.problem} testID="sign-in-problem" announcement={problem.text}>
          {problem.text}
        </LiveText>
      ) : null}
      {problem?.kind === 'api' ? <StateView variant="error" error={problem.error} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { padding: spacing.lg, gap: spacing.md },
  title: { ...type.title, color: colors.text },
  body: { ...type.body, color: colors.textMuted },
  problem: { ...type.body, color: colors.danger },
});
