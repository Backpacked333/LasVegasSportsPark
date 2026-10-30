/**
 * SCR-C-30 "Forms" section of Account (SPK-UX-002; SCR-C-13 wording versions; SPK-REG-009 the
 * signer is recorded; SPK-IAM-003, §4.14): the forms and acknowledgments signed for this person and
 * for each person they hold `view` over (`GET /v1/me` authorities), one list per person from
 * `GET /v1/acknowledgments?subjectPersonId=` (active ones), each with the form's title and version
 * from `GET /v1/policy-versions/{id}`, when and by whom it was signed, and its wording on request.
 * Forms still to sign are presented within a registration (SCR-C-13), not here.
 *
 * A form this person signed can be withdrawn (`POST /v1/acknowledgments/{id}/withdraw` with a
 * reason and its revision), offered only when `GET /v1/me/permissions` lists
 * `catalog.withdraw_acknowledgment`; the API re-checks that the caller is the signer. Withdrawing
 * is recorded, never deleted: signing again records a new acknowledgment.
 *
 * States: loading; empty (no forms signed for a person); ready; validation failure (a reason is
 * required); permission restriction (a person whose forms the API does not show is "not
 * available", no hint of what exists; withdraw is not offered unless listed); stale version
 * (STALE_REVISION or INVALID_TRANSITION on withdraw reloads the list as it is now); offline
 * (cached lists with their age, withdraw disabled); processing (cannot be cancelled while in
 * flight); success (the list shows the form withdrawn, i.e. no longer listed); partial
 * completion: each person's list loads and fails on its own; recovery required: not applicable.
 */
import type { Schema } from '@sportspark/api-client';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { usePermissions } from '../../api/permissions';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { formWording } from '../../features/registration/forms';
import { useConnectivity } from '../../providers/AppProviders';
import { RequireSession } from '../../session/RequireSession';
import { Button } from '../../ui/Button';
import { ListRow } from '../../ui/ListRow';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { Screen } from '../../ui/Screen';
import { StateView } from '../../ui/StateView';
import { spacing } from '../../ui/theme';
import {
  formatDateTime,
  personDisplayName,
  personNameText,
  useMe,
  usePersonName,
  type MeData,
} from './components/account-data';
import { CommandError } from './components/CommandError';
import { Paragraph, SectionHeader, TextField } from './components/forms';

type Acknowledgment = Schema<'Acknowledgment'>;

export const ACKNOWLEDGMENTS_KEY = ['api', '/acknowledgments'] as const;

/** The people whose forms this account may read: itself, then everyone held with `view`. */
export function formSubjects(me: MeData): string[] {
  const out: string[] = [];
  if (me.person) out.push(me.person.id);
  for (const authority of me.authorities) {
    if (!authority.permissions.includes('view')) continue;
    if (!out.includes(authority.subjectPersonId)) out.push(authority.subjectPersonId);
  }
  return out;
}

export function FormsScreen() {
  return (
    <Screen>
      <SectionHeader
        title="Forms and acknowledgments"
        detail="Forms signed for you and the people you manage. Forms still to sign are shown when you register."
      />
      <RequireSession what="your forms">
        <FormsContent />
      </RequireSession>
    </Screen>
  );
}

function FormsContent() {
  const router = useRouter();
  const me = useMe();
  return (
    <QueryBoundary
      query={me}
      label="your account"
      empty={{ title: 'No account details', description: '' }}
      unavailableOffline={['withdrawing a form']}
    >
      {(data) =>
        data.person ? (
          <FormsBody me={data} />
        ) : (
          <StateView
            variant="unavailable"
            title="Finish setting up first"
            description="Forms are shown once your account is linked to your participant record."
            actionLabel="Go to account setup"
            onAction={() => router.push('/onboarding')}
          />
        )
      }
    </QueryBoundary>
  );
}

function FormsBody({ me }: { me: MeData }) {
  const permissions = usePermissions();
  // Offered only when the API lists the action for this account; it re-checks every request.
  const mayWithdraw = Boolean(permissions.actionPermission('catalog.withdraw_acknowledgment'));
  const selfId = me.person?.id ?? '';
  return (
    <View>
      {formSubjects(me).map((personId) => (
        <PersonForms
          key={personId}
          personId={personId}
          selfId={selfId}
          selfName={me.person ? personDisplayName(me.person) : ''}
          mayWithdraw={mayWithdraw}
        />
      ))}
    </View>
  );
}

function PersonForms({
  personId,
  selfId,
  selfName,
  mayWithdraw,
}: {
  personId: string;
  selfId: string;
  selfName: string;
  mayWithdraw: boolean;
}) {
  const isSelf = personId === selfId;
  const name = usePersonName(personId);
  const heading = isSelf ? `You, ${selfName}` : personNameText(name);
  const forms = useApiQuery({
    path: '/acknowledgments',
    request: { query: { subjectPersonId: personId } },
  });
  return (
    <View testID={`forms-person-${isSelf ? 'self' : 'managed'}`}>
      <SectionHeader title={heading} />
      <QueryBoundary
        query={forms}
        label={`forms for ${heading}`}
        isEmpty={(items) => items.length === 0}
        empty={{
          title: 'No forms signed',
          description: 'Forms signed during a registration appear here.',
        }}
        unavailableOffline={['withdrawing a form']}
      >
        {(items) => (
          <View accessibilityRole="list" accessibilityLabel={`Forms for ${heading}`}>
            {items.map((acknowledgment) => (
              <FormRow
                key={acknowledgment.id}
                acknowledgment={acknowledgment}
                selfId={selfId}
                mayWithdraw={mayWithdraw && acknowledgment.signedByPersonId === selfId}
              />
            ))}
          </View>
        )}
      </QueryBoundary>
    </View>
  );
}

function signerDetail(acknowledgment: Acknowledgment, selfId: string, signer: string): string {
  const by = acknowledgment.signedByPersonId === selfId ? 'you' : signer;
  const desk = acknowledgment.recordedByKind === 'staff' ? ', recorded at the front desk' : '';
  return `Signed ${formatDateTime(acknowledgment.signedAt)} by ${by}${desk}`;
}

function FormRow({
  acknowledgment,
  selfId,
  mayWithdraw,
}: {
  acknowledgment: Acknowledgment;
  selfId: string;
  /** This person signed it and the API lists the withdraw action. */
  mayWithdraw: boolean;
}) {
  const [showWording, setShowWording] = useState(false);
  const [withdrawing, setWithdrawing] = useState(false);
  const policy = useApiQuery({
    path: '/policy-versions/{id}',
    request: { path: { id: acknowledgment.policyVersionId } },
  });
  const signer = usePersonName(acknowledgment.signedByPersonId);
  const title = policy.data
    ? `${policy.data.title}, version ${policy.data.version}`
    : policy.error
      ? `Form (wording not available, ${policy.error.code})`
      : 'Loading form…';
  const wording = policy.data ? formWording(policy.data.content) : [];
  return (
    <View testID={`form-${acknowledgment.id}`}>
      <ListRow
        title={title}
        detail={signerDetail(acknowledgment, selfId, personNameText(signer))}
        status={{ tone: 'success', label: 'Signed' }}
      />
      <View style={styles.inset}>
        {wording.length > 0 ? (
          <Button
            label={showWording ? 'Hide wording' : 'Show wording'}
            variant="secondary"
            onPress={() => setShowWording((v) => !v)}
            accessibilityHint="The wording that was signed"
          />
        ) : null}
        {mayWithdraw && !withdrawing ? (
          <Button
            label="Withdraw this form"
            variant="secondary"
            onPress={() => setWithdrawing(true)}
            accessibilityHint="Asks for a reason first"
          />
        ) : null}
      </View>
      {showWording ? (
        <View testID={`form-wording-${acknowledgment.id}`}>
          {wording.map((text, index) => (
            <Paragraph key={index}>{text}</Paragraph>
          ))}
        </View>
      ) : null}
      {withdrawing ? (
        <WithdrawForm acknowledgment={acknowledgment} onClose={() => setWithdrawing(false)} />
      ) : null}
    </View>
  );
}

function WithdrawForm({
  acknowledgment,
  onClose,
}: {
  acknowledgment: Acknowledgment;
  onClose: () => void;
}) {
  const { reachable } = useConnectivity();
  const offline = reachable === false;
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');
  const [attempted, setAttempted] = useState(false);
  const withdraw = useApiCommand('post', '/acknowledgments/{id}/withdraw', {
    invalidate: [ACKNOWLEDGMENTS_KEY],
  });
  // The request of the intent in flight: "Try again" resends it unchanged (§4.9).
  const sent = useRef<{ reason: string; expectedRevision: number } | null>(null);
  const reasonError = reason.trim().length === 0 ? 'Say why you are withdrawing it.' : null;

  const send = async (body: { reason: string; expectedRevision: number }) => {
    sent.current = body;
    try {
      await withdraw.submit({ path: { id: acknowledgment.id }, body });
      sent.current = null;
      onClose();
    } catch {
      // withdraw.error is rendered below; the reason is kept.
    }
  };
  const submit = () => {
    setAttempted(true);
    if (reasonError) return;
    void send({ reason: reason.trim(), expectedRevision: acknowledgment.revision });
  };
  const reload = () => {
    sent.current = null;
    withdraw.reset();
    void queryClient.invalidateQueries({ queryKey: ACKNOWLEDGMENTS_KEY });
    onClose();
  };

  return (
    <View style={styles.form} testID={`form-withdraw-${acknowledgment.id}`}>
      <Paragraph>
        Withdrawing records that this form is no longer signed by you. It cannot be undone; signing
        it again records a new acknowledgment.
      </Paragraph>
      <TextField
        label="Reason for withdrawing"
        value={reason}
        onChangeText={(next) => {
          setReason(next);
          sent.current = null;
          if (withdraw.error) withdraw.reset();
        }}
        error={attempted ? reasonError : null}
        editable={!withdraw.isProcessing}
        testID={`form-withdraw-reason-${acknowledgment.id}`}
      />
      <View style={styles.inset}>
        <Button
          label="Withdraw form"
          onPress={submit}
          busy={withdraw.isProcessing}
          disabled={offline}
          accessibilityHint={offline ? 'Needs a connection' : undefined}
        />
        <Button
          label="Keep it signed"
          variant="secondary"
          onPress={() => {
            sent.current = null;
            withdraw.reset();
            onClose();
          }}
          disabled={withdraw.isProcessing}
          accessibilityHint={withdraw.isProcessing ? 'Waiting for the answer' : undefined}
        />
      </View>
      {withdraw.error?.isStale ? (
        <Paragraph>
          This form changed since it was shown: it may already have been withdrawn.
        </Paragraph>
      ) : null}
      {withdraw.error ? (
        <CommandError
          error={withdraw.error}
          onRetry={() => {
            if (sent.current) void send(sent.current);
          }}
          onReload={reload}
          notFound={{
            title: 'Form not available',
            description: 'This form is no longer listed for you.',
          }}
          denied={{ title: 'You cannot withdraw this form', description: withdraw.error.message }}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  inset: { paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, gap: spacing.sm },
  form: { gap: spacing.sm, paddingTop: spacing.sm },
});
