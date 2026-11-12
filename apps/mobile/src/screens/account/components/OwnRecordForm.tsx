/**
 * Create your own participant record (SCR-C-01 "create or claim the Person"; SPK-IAM-001,
 * SPK-IAM-002, SPK-IAM-007). `POST /v1/me/person` makes the adult record of the signed-in account
 * and links the account to it; it grants nothing else. Email and phone are not asked here: they
 * come from what the sign-in service verified.
 *
 * When the API answers that a record with the same verified email or phone already exists (staff
 * made it at the desk), nothing was created: the person is told to claim that record instead, so
 * no second participant is made.
 *
 * States (SPK-UX-008): ready; validation failure (next to the field, input kept); offline (button
 * disabled, input kept); processing; success; recovery required (already linked: the account is
 * read again).
 */
import type { ApiError } from '@sportspark/api-client';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useApiCommand } from '../../../api/useApiCommand';
import { useConnectivity } from '../../../providers/AppProviders';
import { Button } from '../../../ui/Button';
import { LiveRegion, sentences } from '../../../ui/announce';
import { StatusBadge } from '../../../ui/StatusBadge';
import { spacing } from '../../../ui/theme';
import { ME_QUERY_KEY } from './account-data';
import { CommandError } from './CommandError';
import { Paragraph, TextField } from './forms';

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A real calendar date written year-month-day, not in the future. */
export function dateOfBirthProblem(value: string, today: Date): string | null {
  const match = DATE.exec(value);
  if (!match) return 'Enter the date as year-month-day, for example 1990-04-23.';
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return 'That date does not exist.';
  }
  return date.getTime() > today.getTime() ? 'A date of birth cannot be in the future.' : null;
}

/** RESOURCE_CONFLICT with the API's way forward: a desk-made record holds this verified contact. */
export function existingRecordToClaim(error: ApiError): 'email' | 'phone' | null {
  if (error.code !== 'RESOURCE_CONFLICT') return null;
  const details = error.details as { resolution?: unknown; kind?: unknown } | undefined;
  if (details?.resolution !== 'claim_existing_record') return null;
  return details.kind === 'phone' ? 'phone' : 'email';
}

export function OwnRecordForm({ now = () => new Date() }: { now?: () => Date }) {
  const { reachable } = useConnectivity();
  const offline = reachable === false;
  const queryClient = useQueryClient();
  const [givenName, setGivenName] = useState('');
  const [familyName, setFamilyName] = useState('');
  const [dateOfBirth, setDateOfBirth] = useState('');
  const [attempted, setAttempted] = useState(false);
  const create = useApiCommand('post', '/me/person');

  const problems = {
    givenName: givenName.trim() ? null : 'Enter your first name.',
    familyName: familyName.trim() ? null : 'Enter your last name.',
    dateOfBirth: dateOfBirthProblem(dateOfBirth.trim(), now()),
  };
  const invalid = Boolean(problems.givenName ?? problems.familyName ?? problems.dateOfBirth);

  const submit = async () => {
    setAttempted(true);
    if (invalid) return;
    try {
      await create.submit({
        body: {
          givenName: givenName.trim(),
          familyName: familyName.trim(),
          dateOfBirth: dateOfBirth.trim(),
        },
      });
    } catch (error) {
      // Shown below from create.error; the input is kept (SPK-UX-008). An account that turns out
      // to be linked already is read again, so the screen shows the record it has.
      if ((error as ApiError).code === 'RESOURCE_CONFLICT') {
        await queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY });
      }
      return;
    }
    await queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY });
  };

  if (create.data) {
    const done = 'Your participant record is created and linked to this account.';
    return (
      <LiveRegion
        style={styles.result}
        testID="own-record-result"
        announcement={sentences('Created', done)}
      >
        <StatusBadge tone="success" label="Created" />
        <Paragraph inset={false}>{done}</Paragraph>
      </LiveRegion>
    );
  }

  const edit = (set: (value: string) => void) => (value: string) => {
    set(value);
    if (create.error) create.reset();
  };
  const toClaim = create.error ? existingRecordToClaim(create.error) : null;
  return (
    <View style={styles.form}>
      <Paragraph>
        New here? Create your own record. It is for you, an adult. You add children after this step.
      </Paragraph>
      <TextField
        label="First name"
        value={givenName}
        onChangeText={edit(setGivenName)}
        error={attempted ? problems.givenName : null}
        editable={!create.isProcessing}
        testID="own-given-name"
      />
      <TextField
        label="Last name"
        value={familyName}
        onChangeText={edit(setFamilyName)}
        error={attempted ? problems.familyName : null}
        editable={!create.isProcessing}
        testID="own-family-name"
      />
      <TextField
        label="Date of birth"
        hint="Year-month-day, for example 1990-04-23."
        value={dateOfBirth}
        onChangeText={edit(setDateOfBirth)}
        error={attempted ? problems.dateOfBirth : null}
        editable={!create.isProcessing}
        testID="own-date-of-birth"
      />
      <View style={styles.inset}>
        <Button
          label="Create my record"
          onPress={() => void submit()}
          busy={create.isProcessing}
          disabled={offline}
          accessibilityHint={offline ? 'Needs a connection' : undefined}
        />
      </View>
      {offline ? (
        <Paragraph muted>Creating a record needs a connection. What you typed is kept.</Paragraph>
      ) : null}
      {create.error && toClaim ? (
        <View style={styles.result} testID="own-record-claim-instead">
          <StatusBadge tone="warning" label="A record already exists" />
          <Paragraph inset={false}>
            {`The front desk already has a record with your verified ${toClaim === 'email' ? 'email address' : 'phone number'}. Nothing new was created. Ask the front desk for a claim code and enter it above to link your account to that record.`}
          </Paragraph>
        </View>
      ) : create.error ? (
        <CommandError error={create.error} onRetry={() => void submit()} />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  form: { marginBottom: spacing.md },
  inset: { paddingHorizontal: spacing.lg },
  result: { paddingHorizontal: spacing.lg, paddingVertical: spacing.md, gap: spacing.sm },
});
