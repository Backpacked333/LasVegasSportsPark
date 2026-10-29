/**
 * SCR-C-01 contact-point step (SPK-IAM-001, SPK-IAM-002, journey A2 "Verification pending" to
 * "Verified"): lists the person's contact points from `GET /v1/people/{id}` with their verification
 * state and adds one with `POST /v1/people/{id}/contact-points` (never marked verified by the
 * customer; the API refuses that). Each one can be made the primary of its kind
 * (`POST .../contact-points/{contactPointId}/make-primary`) or removed after a confirmation
 * (`.../remove`); both send the person's revision (contact points are part of the person record),
 * so a change made elsewhere answers STALE_REVISION and the list is reloaded. The API refuses to
 * remove the only verified contact of a person with an account (VALIDATION_FAILED
 * `LAST_VERIFIED_CONTACT`), shown with its reason. Verifying a contact point (sending and checking
 * a code) belongs to the managed identity provider, DEC-018 (Technical lead/account owners): shown
 * as pending.
 */
import type { ApiError, Schema } from '@sportspark/api-client';
import { useQueryClient } from '@tanstack/react-query';
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
type PersonDetail = Schema<'PersonDetail'>;
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
                  <ContactPointRow key={point.id} point={point} person={person} />
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

const PERSON_KEY = ['api', '/people/{id}'] as const;

/** LAST_VERIFIED_CONTACT: the API keeps the only verified contact of a person with an account. */
export function isLastVerifiedContact(error: ApiError | null): boolean {
  const details = error?.details as { code?: unknown } | null | undefined;
  return error?.code === 'VALIDATION_FAILED' && details?.code === 'LAST_VERIFIED_CONTACT';
}

function ContactPointRow({ point, person }: { point: ContactPoint; person: PersonDetail }) {
  const { reachable } = useConnectivity();
  const offline = reachable === false;
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const makePrimary = useApiCommand(
    'post',
    '/people/{id}/contact-points/{contactPointId}/make-primary',
    { invalidate: [PERSON_KEY] },
  );
  const remove = useApiCommand('post', '/people/{id}/contact-points/{contactPointId}/remove', {
    invalidate: [PERSON_KEY],
  });
  // The revision of the intent in flight: "Try again" resends it unchanged (§4.9), even if a
  // refetch has moved the person's revision on.
  const sentRevision = useRef<number | null>(null);
  const kind = point.kind === 'email' ? 'Email' : 'Phone';
  const busy = makePrimary.isProcessing || remove.isProcessing;
  const path = { id: person.id, contactPointId: point.id };

  const sendPrimary = async (expectedRevision: number) => {
    sentRevision.current = expectedRevision;
    try {
      await makePrimary.submit({ path, body: { expectedRevision } });
      sentRevision.current = null;
    } catch {
      // makePrimary.error is rendered below.
    }
  };
  const sendRemove = async (expectedRevision: number) => {
    sentRevision.current = expectedRevision;
    try {
      await remove.submit({ path, body: { expectedRevision } });
      sentRevision.current = null;
    } catch {
      // remove.error is rendered below.
    }
  };
  const reload = () => {
    makePrimary.reset();
    remove.reset();
    sentRevision.current = null;
    setConfirming(false);
    void queryClient.invalidateQueries({ queryKey: PERSON_KEY });
  };
  const error = makePrimary.error ?? remove.error;

  return (
    <View testID={`contact-point-${point.id}`}>
      <ListRow
        title={point.value}
        detail={`${kind}${point.isPrimary ? ', primary' : ''}`}
        status={
          point.verifiedAt
            ? { tone: 'success', label: 'Verified' }
            : { tone: 'pending', label: 'Verification pending' }
        }
      />
      {confirming ? (
        <View style={styles.rowActions}>
          <Paragraph inset={false}>
            {`Remove ${point.value}? Messages and invitations will no longer use it.`}
          </Paragraph>
          <Button
            label={`Confirm removing ${point.value}`}
            onPress={() => void sendRemove(person.revision)}
            busy={remove.isProcessing}
            disabled={offline || busy}
            accessibilityHint={offline ? 'Needs a connection' : undefined}
          />
          <Button
            label="Keep it"
            variant="secondary"
            onPress={() => {
              setConfirming(false);
              remove.reset();
            }}
          />
        </View>
      ) : (
        <View style={styles.rowActions}>
          {point.isPrimary ? null : (
            <Button
              label={`Make ${point.value} the primary ${kind.toLowerCase()}`}
              variant="secondary"
              onPress={() => void sendPrimary(person.revision)}
              busy={makePrimary.isProcessing}
              disabled={offline || busy}
              accessibilityHint={offline ? 'Needs a connection' : undefined}
            />
          )}
          <Button
            label={`Remove ${point.value}`}
            variant="secondary"
            onPress={() => {
              makePrimary.reset();
              setConfirming(true);
            }}
            disabled={offline || busy}
            accessibilityHint={offline ? 'Needs a connection' : 'Asks you to confirm'}
          />
        </View>
      )}
      {error && isLastVerifiedContact(error) ? (
        <StateView
          variant="unavailable"
          title="This contact cannot be removed"
          description={`${error.message} Facility messages and invitations need one email or phone you have verified.`}
        />
      ) : error ? (
        <CommandError
          error={error}
          onRetry={() => {
            const revision = sentRevision.current ?? person.revision;
            void (makePrimary.error ? sendPrimary(revision) : sendRemove(revision));
          }}
          onReload={reload}
          notFound={{
            title: 'Contact not available',
            description: 'This email or phone is no longer on your record.',
            actionLabel: 'Reload',
            onAction: reload,
          }}
        />
      ) : null}
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
  rowActions: { paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, gap: spacing.sm },
});
