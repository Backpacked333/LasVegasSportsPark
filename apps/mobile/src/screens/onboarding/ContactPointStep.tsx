/**
 * SCR-C-01 contact-point step (SPK-IAM-001, SPK-IAM-002, journey A2 "Verification pending" to
 * "Verified"): lists the person's contact points from `GET /v1/people/{id}` with their verification
 * state and adds one with `POST /v1/people/{id}/contact-points` (never marked verified by the
 * customer; the API refuses that). Verifying a contact point (sending and checking a code) belongs
 * to the managed identity provider, DEC-018 (Technical lead/account owners): shown as pending.
 */
import type { ApiError, Schema } from '@sportspark/api-client';
import { useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useApiCommand, type CommandRequest } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { useConnectivity } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { ListRow } from '../../ui/ListRow';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { StateView } from '../../ui/StateView';
import { spacing } from '../../ui/theme';
import { CommandError } from '../account/components/CommandError';
import { ChoiceGroup, Paragraph, SectionHeader, TextField } from '../account/components/forms';

type ContactPoint = Schema<'ContactPoint'>;
type ContactKind = ContactPoint['kind'];
type AddRequest = CommandRequest<'post', '/people/{id}/contact-points'>;

export type ContactState = 'verified' | 'pending' | 'none';

export function contactState(points: readonly ContactPoint[]): ContactState {
  if (points.some((p) => p.verifiedAt !== null)) return 'verified';
  return points.length > 0 ? 'pending' : 'none';
}

/** Format checks before sending; the API's VALIDATION_FAILED stays authoritative. */
export function contactFormatError(kind: ContactKind, value: string): string | null {
  const v = value.trim();
  if (v.length === 0) return kind === 'email' ? 'Enter an email address.' : 'Enter a phone number.';
  if (v.length < 3 || v.length > 320) return 'Enter between 3 and 320 characters.';
  if (kind === 'email' && !/^[^\s@]+@[^\s@]+$/.test(v)) {
    return 'Enter an email address in the form name@example.com.';
  }
  if (kind === 'phone' && (v.replace(/\D/g, '').length < 7 || /[^0-9+\-().\s]/.test(v))) {
    return 'Enter a phone number using digits, spaces and an optional leading +.';
  }
  return null;
}

export function ContactPointStep({ personId }: { personId: string }) {
  const detail = useApiQuery({ path: '/people/{id}', request: { path: { id: personId } } });
  return (
    <View>
      <SectionHeader
        title="Email or phone"
        detail="Facility messages and invitations use a verified email or phone."
      />
      <QueryBoundary
        query={detail}
        label="your contact details"
        empty={{ title: 'No contact details', description: '' }}
        unavailableOffline={['adding an email or phone']}
      >
        {(person) => (
          <View>
            {person.contactPoints.length === 0 ? (
              <Paragraph muted>No email or phone has been added yet.</Paragraph>
            ) : (
              <View accessibilityRole="list">
                {person.contactPoints.map((point) => (
                  <ListRow
                    key={point.id}
                    title={point.value}
                    detail={`${point.kind === 'email' ? 'Email' : 'Phone'}${point.isPrimary ? ', primary' : ''}`}
                    status={
                      point.verifiedAt
                        ? { tone: 'success', label: 'Verified' }
                        : { tone: 'pending', label: 'Verification pending' }
                    }
                  />
                ))}
              </View>
            )}
            <AddContactPoint personId={personId} existing={person.contactPoints} />
          </View>
        )}
      </QueryBoundary>
      <StateView
        variant="pending-decision"
        subject="Verifying an email or phone in the app"
        decisions={['DEC-018']}
        owner="Technical lead/account owners"
      />
    </View>
  );
}

function AddContactPoint({
  personId,
  existing,
}: {
  personId: string;
  existing: readonly ContactPoint[];
}) {
  const { reachable } = useConnectivity();
  const offline = reachable === false;
  const [kind, setKind] = useState<ContactKind>('email');
  const [value, setValue] = useState('');
  const [attempted, setAttempted] = useState(false);
  const add = useApiCommand('post', '/people/{id}/contact-points', {
    invalidate: [['api', '/people/{id}']],
  });

  const formatError = contactFormatError(kind, value);
  const apiFieldError = add.error?.code === 'VALIDATION_FAILED' ? add.error.message : null;
  // The exact request of the intent in flight (§4.9): "Try again" resends it unchanged, so a
  // refetch of the person between attempts (which can flip `isPrimary`) never makes a new key and
  // a second contact point. Cleared on success, on reset and when the input changes.
  const sent = useRef<AddRequest | null>(null);

  const send = async (request: AddRequest) => {
    sent.current = request;
    try {
      await add.submit(request);
      sent.current = null;
      setValue('');
      setAttempted(false);
    } catch {
      // add.error is rendered below; the entered value is kept.
    }
  };

  const submit = async () => {
    setAttempted(true);
    if (formatError) return;
    await send({
      path: { id: personId },
      body: {
        kind,
        value: value.trim(),
        // Primary only when there is none of this kind yet: never demote an existing primary.
        isPrimary: !existing.some((p) => p.kind === kind),
        verified: false,
      },
    });
  };

  const retry = async () => {
    if (sent.current) await send(sent.current);
    else await submit();
  };

  const resetIntent = () => {
    sent.current = null;
    add.reset();
  };

  return (
    <View style={styles.form}>
      <ChoiceGroup<ContactKind>
        label="Add"
        value={kind}
        onChange={(next) => {
          setKind(next);
          resetIntent();
        }}
        options={[
          { value: 'email', label: 'Email' },
          { value: 'phone', label: 'Phone' },
        ]}
        disabled={add.isProcessing}
      />
      <TextField
        label={kind === 'email' ? 'Email address' : 'Phone number'}
        value={value}
        onChangeText={(next) => {
          setValue(next);
          resetIntent();
        }}
        keyboardType={kind === 'email' ? 'email-address' : 'phone-pad'}
        autoComplete={kind === 'email' ? 'email' : 'tel'}
        error={(attempted ? formatError : null) ?? apiFieldError}
        editable={!add.isProcessing}
        testID="contact-value"
      />
      <View style={styles.actions}>
        <Button
          label={kind === 'email' ? 'Add email' : 'Add phone'}
          onPress={() => void submit()}
          busy={add.isProcessing}
          disabled={offline}
          accessibilityHint={offline ? 'Needs a connection' : undefined}
        />
      </View>
      {add.error && !apiFieldError ? <AddError error={add.error} onRetry={retry} /> : null}
    </View>
  );
}

function AddError({ error, onRetry }: { error: ApiError; onRetry: () => Promise<void> }) {
  return <CommandError error={error} onRetry={() => void onRetry()} />;
}

const styles = StyleSheet.create({
  form: { gap: spacing.md, paddingTop: spacing.md },
  actions: { paddingHorizontal: spacing.lg },
});
