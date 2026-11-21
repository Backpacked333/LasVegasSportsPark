/**
 * The redesigned welcome (handoff M 5a, 5b) in demo mode (development builds only; compiled out of
 * release bundles through the conditional require in `./index.ts`). A deterministic stand-in for
 * the identity provider, which is not selected (DEC-018): any phone or email "receives" the code
 * shown on screen, and the right code signs in as the seeded parent through the API's local
 * identity provider (`POST /v1/dev/tokens`, which exists only on a development API). A wrong code
 * is refused, so the shake and the message can be seen. "Sign in as the parent" stays for the
 * family tour.
 */
import { useRouter } from 'expo-router';
import { useMemo } from 'react';
import { Pressable, Text } from 'react-native';
import { useApiCommand } from '../api/useApiCommand';
import type { CodeSignInPort } from '../features/sign-in/code-sign-in';
import { useApp } from '../providers/AppProviders';
import { WelcomeFlow } from '../screens/sign-in/WelcomeFlow';
import { fonts, makeStyles, MIN_TOUCH_SIZE } from '../ui/theme';
import { setDemoState } from './store';
import { DEMO_PARENT_SUBJECT, FAMILY_TOUR } from './tour';

/** The demo's code (the design's example). */
export const DEMO_CODE = '481052';

export function DemoWelcome() {
  const { signIn, services } = useApp();
  const router = useRouter();
  const styles = useStyles();
  const mint = useApiCommand('post', '/dev/tokens');
  const accountId = services.config.demoAccounts?.[DEMO_PARENT_SUBJECT];

  const port = useMemo<CodeSignInPort>(
    () => ({
      hint: `Demo mode: the code is ${DEMO_CODE}.`,
      requestCode: async () => ({ resendAfterSeconds: 60 }),
      verifyCode: async (_contact, code) => {
        if (code !== DEMO_CODE || !accountId) return { kind: 'wrong' };
        const token = await mint.submit({ body: { accountId } });
        return {
          kind: 'signed_in',
          session: { token: token.token, expiresAt: token.expiresAt, accountId: token.accountId },
        };
      },
    }),
    [accountId, mint],
  );

  const tour = async () => {
    if (!accountId) return;
    try {
      const token = await mint.submit({ body: { accountId } });
      setDemoState({ active: true, step: 0, open: true });
      await signIn({ token: token.token, expiresAt: token.expiresAt, accountId: token.accountId });
      router.replace(FAMILY_TOUR[0]?.path ?? '/');
    } catch {
      // The welcome stays; the code path shows its own message.
    }
  };

  return (
    <WelcomeFlow
      port={port}
      extra={
        <Pressable
          onPress={() => void tour()}
          disabled={!accountId}
          accessibilityRole="button"
          accessibilityLabel="Sign in as the parent"
          style={styles.tour}
        >
          <Text style={styles.tourText}>Sign in as the parent (demo tour)</Text>
        </Pressable>
      }
    />
  );
}

const useStyles = makeStyles(({ colors }) => ({
  tour: { minHeight: MIN_TOUCH_SIZE, alignItems: 'center', justifyContent: 'center' },
  tourText: { ...fonts.semibold, fontSize: 14, color: colors.floodlight },
}));
