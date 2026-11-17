/** SCR-C-01: create an adult person for the signed-in, unlinked account; identity-provider signup remains DEC-018. */
import type { ApiError } from '@sportspark/api-client';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useApiCommand } from '../../api/useApiCommand';
import { forgetLinkSecretIfUnchanged, readLinkSecret } from '../../links/link-secrets';
import { useConnectivity } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { CommandError } from '../../ui/CommandError';
import { DateField } from '../../ui/DateField';
import { TextField } from '../../ui/Field';
import { LiveRegion, sentences } from '../../ui/announce';
import { StatusBadge } from '../../ui/StatusBadge';
import { Text } from '../../ui/Text';
import { layout, spacing } from '../../ui/theme';
import { ME_QUERY_KEY } from '../account/components/account-data';

function dateOfBirthError(error: ApiError | null): string | null {
  if (error?.code !== 'VALIDATION_FAILED') return null;
  const details = error.details;
  if (
    typeof details === 'object' &&
    details !== null &&
    'derivedKind' in details &&
    details.derivedKind === 'child'
  ) {
    return 'This date of birth is below the adult registration age. Ask the front desk to help you.';
  }
  if (error.message === 'dateOfBirth cannot be in the future.') {
    return 'Enter a date of birth in the past.';
  }
  return null;
}

export function SelfRegistrationForm({ initialClaimToken }: { initialClaimToken: string | null }) {
  const { reachable } = useConnectivity();
  const offline = reachable === false;
  const [claimTokenAtEntry] = useState(() => initialClaimToken ?? readLinkSecret('claim'));
  const [givenName, setGivenName] = useState('');
  const [familyName, setFamilyName] = useState('');
  const [dateOfBirth, setDateOfBirth] = useState<string | null>(null);
  const [attempted, setAttempted] = useState(false);
  const registration = useApiCommand('post', '/me/registration', {
    invalidate: [ME_QUERY_KEY],
    beforeInvalidate: () => {
      if (claimTokenAtEntry !== null) {
        forgetLinkSecretIfUnchanged('claim', claimTokenAtEntry);
      }
    },
  });

  const givenNameError = attempted && givenName.trim() === '' ? 'Enter your given name.' : null;
  const familyNameError = attempted && familyName.trim() === '' ? 'Enter your family name.' : null;
  const dateError =
    (attempted && dateOfBirth === null ? 'Enter a valid date of birth.' : null) ??
    dateOfBirthError(registration.error);

  const submit = async () => {
    setAttempted(true);
    if (givenName.trim() === '' || familyName.trim() === '' || dateOfBirth === null) return;
    try {
      await registration.submit({
        body: {
          givenName: givenName.trim(),
          familyName: familyName.trim(),
          dateOfBirth,
        },
      });
    } catch {
      return;
    }
  };

  const changeGivenName = (value: string) => {
    setGivenName(value);
    if (registration.error) registration.reset();
  };
  const changeFamilyName = (value: string) => {
    setFamilyName(value);
    if (registration.error) registration.reset();
  };
  const changeDateOfBirth = (value: string | null) => {
    setDateOfBirth(value);
    if (registration.error) registration.reset();
  };

  if (registration.data) {
    const message = 'Your adult record is linked to this account. Continue with email or phone.';
    return (
      <LiveRegion style={styles.result} announcement={sentences('Record created', message)}>
        <StatusBadge tone="success" label="Record created" />
        <Text>{message}</Text>
      </LiveRegion>
    );
  }

  return (
    <View style={styles.form}>
      <Text inset>
        Create an adult record for this signed-in account. You can add an email or phone in the next
        step.
      </Text>
      <TextField
        label="Given name"
        autoCapitalize="words"
        autoComplete="given-name"
        required
        error={givenNameError}
        style={styles.field}
        value={givenName}
        onChangeText={changeGivenName}
        editable={!registration.isProcessing}
        testID="registration-given-name"
      />
      <TextField
        label="Family name"
        autoCapitalize="words"
        autoComplete="family-name"
        required
        error={familyNameError}
        style={styles.field}
        value={familyName}
        onChangeText={changeFamilyName}
        editable={!registration.isProcessing}
        testID="registration-family-name"
      />
      <DateField
        label="Date of birth"
        hint="Year-month-day, for example 1990-05-12."
        required
        error={dateError}
        value={dateOfBirth}
        onChange={changeDateOfBirth}
        disabled={registration.isProcessing}
        testID="registration-date-of-birth"
        style={styles.field}
      />
      {offline ? (
        <Text tone="muted" inset>
          Creating your record needs a connection. Your details are kept.
        </Text>
      ) : null}
      <View style={styles.action}>
        <Button
          label="Create and link my record"
          onPress={() => void submit()}
          busy={registration.isProcessing}
          disabled={offline}
          accessibilityHint={offline ? 'Needs a connection' : undefined}
          testID="register-self"
        />
      </View>
      {registration.error && !dateOfBirthError(registration.error) ? (
        <CommandError
          error={registration.error}
          onRetry={() => void submit()}
          wording="registration"
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  form: { gap: spacing.md },
  field: { paddingHorizontal: layout.gutter },
  action: { paddingHorizontal: spacing.lg },
  result: { paddingHorizontal: spacing.lg, gap: spacing.sm },
});
