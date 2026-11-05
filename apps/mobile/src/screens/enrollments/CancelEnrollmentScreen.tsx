/**
 * SCR-C-33 Cancellation and transfer preview: cancellation (SPK-REG-010, SPK-PAY-008, SPK-PAY-009,
 * §4.9, SPK-UX-008; POL-007 to POL-009 and DEC-009 govern the money and are the API's policy).
 *
 * Before commitment the screen shows what the API's `GET /v1/enrollments/{id}/cancellation-preview`
 * says: the existing participation, the affected dates, the capacity that is released, the refund,
 * credit or additional charge with the API's own explanation, and whether approval is required.
 * The customer gives a reason and confirms that they understand the money consequence; only then
 * `POST /v1/enrollments/{id}/cancel` is sent, with `expectedRevision`, the accepted consequence
 * (`acceptedConsequence`: kind, amount and currency as previewed, ENR-03) and one idempotency key
 * per intent (a retry after no answer reuses it and cannot cancel twice).
 *
 * Stale version: the preview is read again when the customer confirms; if the money consequence
 * changed, nothing is sent and the new consequence must be acknowledged. The API binds the
 * acceptance too: a consequence that changed between that read and the commit is refused
 * (RESOURCE_CONFLICT `CONSEQUENCE_CHANGED` or `CONSEQUENCE_ACCEPTANCE_REQUIRED`), nothing is
 * canceled, and the screen asks for the new one to be accepted. A STALE_REVISION answer reloads
 * the record and keeps the typed reason.
 *
 * States: loading; empty: not applicable; ready (preview); validation failure (reason missing:
 * field message, input kept); permission restriction (not available); stale version (re-preview);
 * offline (confirm disabled, "Needs a connection"); processing ("Canceling…", busy); success
 * ("Canceled" with the recorded consequence); partial completion: not permitted; recovery
 * required: a refund outcome cannot be shown (the API records the consequence on the enrollment
 * but exposes no refund for it to the customer; reported).
 */
import type { ApiError, Schema } from '@sportspark/api-client';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { CommandFailure } from '../../features/money/CommandFailure';
import { formatDateRange } from '../../features/money/format';
import { useNameOf } from '../../features/money/people';
import { combineQueries } from '../../features/money/queries';
import { moneyRoutes, param } from '../../features/money/routes';
import {
  consequenceSummary,
  enrollmentStatus,
  sameConsequence,
  type CancellationPreview,
  type Enrollment,
  type FinancialConsequence,
} from '../../features/money/status';
import {
  Body,
  ButtonRow,
  Caption,
  ChoiceRow,
  Field,
  Section,
  TextField,
} from '../../features/money/ui';
import { useConnectivity } from '../../providers/AppProviders';
import { RequireSession } from '../../session/RequireSession';
import { Button } from '../../ui/Button';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { Screen } from '../../ui/Screen';
import { NotFoundScreen } from '../not-found/NotFoundScreen';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';
import { acceptedOf, consequenceConflict } from './participation';

type CancelBody = Schema<'CancelEnrollmentRequest'>;

function ConsequenceBlock({ consequence }: { consequence: FinancialConsequence }) {
  const summary = consequenceSummary(consequence);
  return (
    <>
      <StatusBadge tone={summary.tone} label={summary.headline} testID="consequence" />
      <Body>{summary.explanation}</Body>
      {consequence.policyVersionId ? (
        <Caption>Worked out under the activity’s cancellation policy.</Caption>
      ) : null}
    </>
  );
}

function Canceled({ enrollment }: { enrollment: Enrollment }) {
  const router = useRouter();
  const recorded = enrollment.cancellationConsequence
    ? consequenceSummary(enrollment.cancellationConsequence)
    : null;
  return (
    <Section title="Registration canceled">
      <StatusBadge {...enrollmentStatus(enrollment)} testID="cancel-success" />
      {recorded ? (
        <>
          <Field label="Recorded money consequence" value={recorded.headline} />
          <Body>{recorded.explanation}</Body>
          <Caption>
            Refunds and credits are carried out by the facility. This app cannot show their progress
            yet; ask the front desk if you have a question.
          </Caption>
        </>
      ) : null}
      <ButtonRow>
        <Button
          label="Back to enrollments"
          onPress={() => router.replace(moneyRoutes.enrollments())}
        />
        <Button
          label="Open payments"
          variant="secondary"
          onPress={() => router.push(moneyRoutes.payments())}
        />
      </ButtonRow>
    </Section>
  );
}

function CancelForm({
  enrollment,
  preview,
  refetchPreview,
  reloadAll,
}: {
  enrollment: Enrollment;
  preview: CancellationPreview;
  /** Reads the preview again and resolves with the API's latest answer. */
  refetchPreview: () => Promise<CancellationPreview | undefined>;
  reloadAll: () => void;
}) {
  const { reachable } = useConnectivity();
  const offline = reachable === false;
  const nameOf = useNameOf();
  const cancel = useApiCommand('post', '/enrollments/{id}/cancel', {
    invalidate: [
      ['api', '/enrollments'],
      ['api', '/enrollments/{id}'],
    ],
  });
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | null>(null);
  /** The consequence the customer acknowledged; null until they tick the box. */
  const [acknowledged, setAcknowledged] = useState<FinancialConsequence | null>(null);
  const [changed, setChanged] = useState(false);
  const [failure, setFailure] = useState<ApiError | null>(null);
  const [done, setDone] = useState<Enrollment | null>(null);
  const [checking, setChecking] = useState(false);

  if (done) return <Canceled enrollment={done} />;

  const summary = consequenceSummary(preview.financialConsequence);
  const send = async (body: CancelBody) => {
    setFailure(null);
    try {
      setDone(await cancel.submit({ path: { id: enrollment.id }, body }));
    } catch (error) {
      const apiError = error as ApiError;
      if (consequenceConflict(apiError)) {
        // ENR-03: the consequence changed after it was accepted; nothing was canceled.
        setChanged(true);
        setAcknowledged(null);
        cancel.reset();
        await refetchPreview();
        return;
      }
      setFailure(apiError);
    }
  };
  const bodyFor = (accepted: FinancialConsequence, trimmed: string): CancelBody => ({
    expectedRevision: enrollment.revision,
    reason: trimmed,
    acceptedConsequence: acceptedOf(accepted),
  });

  const confirm = async () => {
    const trimmed = reason.trim();
    if (trimmed.length === 0) {
      setReasonError('Enter a reason for canceling.');
      return;
    }
    if (!acknowledged) return;
    setChecking(true);
    // Stale version: read the preview again; a changed consequence must be acknowledged again.
    const fresh = (await refetchPreview()) ?? preview;
    setChecking(false);
    if (!sameConsequence(fresh.financialConsequence, acknowledged)) {
      setChanged(true);
      setAcknowledged(null);
      return;
    }
    await send(bodyFor(acknowledged, trimmed));
  };

  const reload = () => {
    setFailure(null);
    cancel.reset();
    setAcknowledged(null);
    reloadAll();
  };

  return (
    <View>
      <Section title="What you have now">
        <Field label="Participant" value={nameOf(enrollment.participantPersonId)} />
        <Field label="Activity" value={preview.existing.offeringName} />
        <Field
          label="Dates"
          value={formatDateRange(preview.existing.startsOn, preview.existing.endsOn)}
        />
        <StatusBadge
          {...enrollmentStatus(enrollment, { offeringName: preview.existing.offeringName })}
        />
      </Section>

      <Section title="What would change">
        <Field
          label="Affected dates"
          value={formatDateRange(preview.affectedDates.startsOn, preview.affectedDates.endsOn)}
        />
        <Field
          label="Your place"
          value={
            preview.capacity.released.length > 0
              ? 'Released, so someone else can take it'
              : 'No place is held for this registration'
          }
        />
        <Field
          label="Approval"
          value={
            preview.requiredApproval
              ? 'Staff approval is required before this takes effect'
              : 'No approval needed'
          }
        />
      </Section>

      <Section title="Money" testID="money-consequence">
        <ConsequenceBlock consequence={preview.financialConsequence} />
      </Section>

      {!preview.permitted ? (
        <StateView
          variant="unavailable"
          title="Cannot be canceled"
          description={`This registration can no longer be canceled: it is ${enrollmentStatus(enrollment).label.toLowerCase()}.`}
        />
      ) : (
        <Section title="Cancel this registration">
          {changed ? (
            <StatusBadge
              tone="warning"
              label="The money consequence changed since you reviewed it. Review it again."
              testID="consequence-changed"
            />
          ) : null}
          <TextField
            label="Reason for canceling"
            value={reason}
            onChangeText={(text) => {
              setReason(text);
              if (text.trim()) setReasonError(null);
            }}
            error={reasonError}
            multiline
            testID="cancel-reason"
          />
          <ChoiceRow
            mode="checkbox"
            label={`I understand: ${summary.headline}`}
            checked={acknowledged !== null}
            onPress={() => {
              setChanged(false);
              setAcknowledged(acknowledged ? null : preview.financialConsequence);
            }}
          />
          {offline ? <Caption>Needs a connection.</Caption> : null}
          <ButtonRow>
            <Button
              label="Cancel registration"
              onPress={() => void confirm()}
              disabled={offline || acknowledged === null}
              busy={cancel.isProcessing || checking}
              accessibilityHint="Cancels the registration with the money consequence shown above"
            />
          </ButtonRow>
          {failure ? (
            <CommandFailure
              error={failure}
              what="the cancellation"
              onRetry={() => {
                if (acknowledged) void send(bodyFor(acknowledged, reason.trim()));
              }}
              onReload={reload}
            />
          ) : null}
        </Section>
      )}
    </View>
  );
}

export function CancelEnrollmentScreen({ enrollmentId }: { enrollmentId: string }) {
  const enrollment = useApiQuery({
    path: '/enrollments/{id}',
    request: { path: { id: enrollmentId } },
  });
  const preview = useApiQuery({
    path: '/enrollments/{id}/cancellation-preview',
    request: { path: { id: enrollmentId } },
    staleTime: 0,
  });
  const both = combineQueries(enrollment, preview);
  return (
    <Screen>
      <RequireSession what="this cancellation">
        <QueryBoundary
          query={both}
          label="the cancellation preview"
          empty={{ title: 'Not available', description: '' }}
          unavailableOffline={['canceling']}
        >
          {({ a, b }) => (
            <CancelForm
              enrollment={a}
              preview={b as CancellationPreview}
              refetchPreview={async () =>
                (await preview.refetch()).data?.data as CancellationPreview | undefined
              }
              reloadAll={() => void both.refetch()}
            />
          )}
        </QueryBoundary>
      </RequireSession>
    </Screen>
  );
}

/** Route component for app/enrollments/[id]/cancel.tsx. */
export function CancelEnrollmentRoute() {
  const id = param(useLocalSearchParams<{ id: string }>().id);
  return (
    <>
      <Stack.Screen options={{ title: 'Cancellation preview' }} />
      {id ? <CancelEnrollmentScreen enrollmentId={id} /> : <NotFoundScreen />}
    </>
  );
}
