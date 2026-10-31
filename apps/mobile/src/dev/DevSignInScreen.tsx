/**
 * Development sign-in (development builds only). Asks the API for a token from its local identity
 * provider (`POST /v1/dev/tokens`), which exists only when the API runs with AUTH_MODE=local
 * outside production and answers NOT_FOUND otherwise (§5.2). The account id is never logged.
 */
import { presentationForError, type ApiError } from '@sportspark/api-client';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { useApiCommand } from '../api/useApiCommand';
import { useApp } from '../providers/AppProviders';
import { Button } from '../ui/Button';
import { Screen } from '../ui/Screen';
import { StateView } from '../ui/StateView';
import { colors, MIN_TOUCH_SIZE, spacing, type } from '../ui/theme';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function DevSignInScreen() {
  const { signIn } = useApp();
  const router = useRouter();
  const [accountId, setAccountId] = useState('');
  const mint = useApiCommand('post', '/dev/tokens');
  const valid = UUID.test(accountId.trim());

  const submit = async () => {
    try {
      const token = await mint.submit({ body: { accountId: accountId.trim() } });
      await signIn({ token: token.token, expiresAt: token.expiresAt, accountId: token.accountId });
      router.replace('/');
    } catch {
      // The error is rendered below from mint.error; the input is kept (SPK-UX-008).
    }
  };

  return (
    <Screen>
      <View style={styles.form}>
        <Text style={styles.title} accessibilityRole="header">
          Development sign-in
        </Text>
        <Text style={styles.body}>
          Gets a token from the API's local identity provider. Works only against an API running in
          development.
        </Text>
        <Text style={styles.label} nativeID="account-id-label">
          Account id
        </Text>
        <TextInput
          value={accountId}
          onChangeText={setAccountId}
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel="Account id"
          accessibilityLabelledBy="account-id-label"
          placeholder="00000000-0000-7000-8000-000000000000"
          style={styles.input}
          testID="dev-account-id"
        />
        {accountId.length > 0 && !valid ? (
          <Text style={styles.error} accessibilityLiveRegion="polite">
            Enter the account id as a UUID.
          </Text>
        ) : null}
        <Button
          label="Sign in"
          onPress={() => void submit()}
          disabled={!valid}
          busy={mint.isProcessing}
          testID="dev-sign-in"
        />
      </View>
      {mint.error ? <DevSignInError error={mint.error} /> : null}
    </Screen>
  );
}

function DevSignInError({ error }: { error: ApiError }) {
  if (presentationForError(error) === 'unavailable') {
    return (
      <StateView
        variant="unavailable"
        title="Development sign-in not available"
        description="The API is not running with its local identity provider, or no active local account has this id."
      />
    );
  }
  return <StateView variant="error" error={error} />;
}

const styles = StyleSheet.create({
  form: { padding: spacing.lg, gap: spacing.md },
  title: { ...type.title, color: colors.text },
  body: { ...type.body, color: colors.text },
  label: { ...type.body, fontWeight: '600', color: colors.text },
  input: {
    ...type.body,
    minHeight: MIN_TOUCH_SIZE,
    borderWidth: 1.5,
    borderColor: colors.border,
    borderRadius: 6,
    paddingHorizontal: spacing.md,
    color: colors.text,
  },
  error: { ...type.caption, color: colors.danger },
});
