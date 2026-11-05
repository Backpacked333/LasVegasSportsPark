/**
 * SCR-C-33 Cancellation and transfer preview: transfer (SPK-REG-010, SPK-PAY-008, SPK-PAY-009,
 * §4.8 `POST /v1/enrollments/{id}/transfer`, §4.9, SPK-UX-008; POL-007 to POL-009 and DEC-009
 * govern transfer money and are the API's policy, never the app's).
 *
 * 1. Choose the target among the published offerings of the same program (`GET /v1/offerings`).
 * 2. Preview: the read-only `GET /v1/enrollments/{id}/transfer-preview?targetOfferingId=` (ENR-03)
 *    returns the existing and proposed participation, both date ranges and whether they overlap,
 *    the capacity required and whether anyone is waiting ahead, the eligibility result with its
 *    reasons, the refund, credit or additional charge with the API's explanation, and whether
 *    staff approval is required. Nothing changes, and no command is sent to preview.
 * 3. Confirm: the customer acknowledges the money consequence; the preview is read again and, if
 *    the consequence changed, nothing is committed and the new one must be acknowledged. Then
 *    `POST /v1/enrollments/{id}/transfer` with `commit: true`, the accepted consequence
 *    (`acceptedConsequence`: kind, amount and currency) and `expectedRevision`. The API binds the
 *    acceptance: a consequence that changed since is refused (RESOURCE_CONFLICT
 *    `CONSEQUENCE_CHANGED` or `CONSEQUENCE_ACCEPTANCE_REQUIRED`, with the current consequence),
 *    nothing is committed, and the new consequence is shown to accept. A retry after no answer
 *    reuses the same idempotency key and cannot transfer twice.
 * 4. Success: "Transferred to <offering>" with the linked old and new enrollments.
 *
 * A transfer that needs approval is not committed by a customer (the API answers
 * RESOURCE_CONFLICT `APPROVAL_REQUIRED`): the screen says staff approval is needed and how to ask.
 *
 * States: loading; empty (no other offering to move to); ready (preview); validation failure
 * (target ineligible: the API's reasons); permission restriction ("Staff approval needed", not
 * available); stale version (capacity or price changed: re-preview; STALE_REVISION reloads);
 * offline (disabled); processing (busy); success (linked enrollments); partial completion: not
 * permitted; recovery required: not applicable, the transfer is one transaction in the API.
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
import { moneyRoutes, param } from '../../features/money/routes';
import {
  consequenceSummary,
  enrollmentStatus,
  sameConsequence,
  type Enrollment,
  type FinancialConsequence,
  type TransferPreview,
} from '../../features/money/status';
import { Body, ButtonRow, Caption, ChoiceRow, Field, Section } from '../../features/money/ui';
import { useConnectivity } from '../../providers/AppProviders';
import { RequireSession } from '../../session/RequireSession';
import { Button } from '../../ui/Button';
import { ListRow } from '../../ui/ListRow';
import { QueryBoundary, QueryErrorView } from '../../ui/QueryBoundary';
import { Screen } from '../../ui/Screen';
import { NotFoundScreen } from '../not-found/NotFoundScreen';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';
import { acceptedOf, consequenceConflict } from './participation';

type PublicOffering = Schema<'PublicOffering'>;
type TransferBody = Schema<'TransferEnrollmentRequest'>;

/** Conflict sub-codes the transfer command sends in `details.code`. */
export function conflictCode(error: ApiError | null): string | null {
  if (error?.code !== 'RESOURCE_CONFLICT') return null;
  const details = error.details as { code?: unknown } | undefined;
  return typeof details?.code === 'string' ? details.code : null;
}

/** What stops a customer from committing this preview, in the customer's words. */
export function transferBlockers(preview: TransferPreview): string[] {
  const out: string[] = [];
  if (!preview.eligibility.eligible) {
    out.push('Not eligible for this activity.');
  }
  if (preview.requiredApproval) {
    out.push('Staff approval is needed. Ask the front desk to make this transfer.');
  }
  if (preview.capacity.waitlistAhead > 0) {
    out.push(
      `${preview.capacity.waitlistAhead} ${preview.capacity.waitlistAhead === 1 ? 'person is' : 'people are'} waiting for this activity; places go to them first.`,
    );
  } else if (!preview.capacity.sufficient) {
    out.push('No place is available in this activity.');
  }
  return out;
}

function PreviewView({ preview }: { preview: TransferPreview }) {
  const summary = consequenceSummary(preview.financialConsequence);
  return (
    <View testID="transfer-preview">
      <Section title="From">
        <Field label="Activity" value={preview.existing.offeringName} />
        <Field
          label="Dates"
          value={formatDateRange(
            preview.affectedDates.existingRange.startsOn,
            preview.affectedDates.existingRange.endsOn,
          )}
        />
      </Section>
      <Section title="To">
        <Field label="Activity" value={preview.proposed.offeringName} />
        <Field
          label="Dates"
          value={formatDateRange(
            preview.affectedDates.proposedRange.startsOn,
            preview.affectedDates.proposedRange.endsOn,
          )}
        />
        {preview.affectedDates.overlapping ? (
          <Caption>The two activities overlap in time.</Caption>
        ) : null}
        <Field
          label="Place"
          value={
            preview.capacity.sufficient
              ? 'A place is available'
              : preview.capacity.waitlistAhead > 0
                ? 'Others are waiting for a place'
                : 'No place is available'
          }
        />
        <Field
          label="Eligibility"
          value={preview.eligibility.eligible ? 'Eligible' : 'Not eligible'}
        />
        {preview.eligibility.reasons.map((reason) => (
          <Caption key={`${reason.code}-${reason.message}`}>▲ {reason.message}</Caption>
        ))}
        <Field
          label="Approval"
          value={preview.requiredApproval ? 'Staff approval is required' : 'No approval needed'}
        />
      </Section>
      <Section title="Money" testID="money-consequence">
        <StatusBadge tone={summary.tone} label={summary.headline} testID="consequence" />
        <Body>{summary.explanation}</Body>
      </Section>
    </View>
  );
}

function Transferred({ preview }: { preview: TransferPreview }) {
  const router = useRouter();
  const next = preview.newEnrollment;
  const previous = preview.previousEnrollment;
  const recorded = consequenceSummary(preview.financialConsequence);
  return (
    <Section title="Transfer complete">
      <StatusBadge
        tone="success"
        label={`Transferred to ${preview.proposed.offeringName}`}
        testID="transfer-success"
      />
      <Field label="Money consequence" value={recorded.headline} />
      <Caption>The old and new enrollments stay linked, and attendance history is kept.</Caption>
      {previous ? (
        <ListRow
          title={preview.existing.offeringName}
          status={enrollmentStatus(previous, {
            transferTargetName: preview.proposed.offeringName,
          })}
        />
      ) : null}
      {next ? (
        <ListRow
          title={preview.proposed.offeringName}
          status={enrollmentStatus(next, { offeringName: preview.proposed.offeringName })}
          onPress={() => router.replace(moneyRoutes.enrollment(next.id))}
          accessibilityHint="Opens the new enrollment"
        />
      ) : null}
    </Section>
  );
}

function TransferForm({ enrollment, reload }: { enrollment: Enrollment; reload: () => void }) {
  const { reachable } = useConnectivity();
  const offline = reachable === false;
  const nameOf = useNameOf();
  const current = useApiQuery({
    path: '/offerings/{id}',
    request: { path: { id: enrollment.offeringId } },
  });
  const programId = current.data?.programId;
  // Targets are the published offerings of the same program only: never listed without it.
  const offerings = useApiQuery({
    path: '/offerings',
    request: { query: { programId: programId ?? '', limit: 50 } },
    enabled: programId !== undefined && enrollment.status === 'confirmed',
  });
  const [targetId, setTargetId] = useState<string | null>(null);
  /** The target whose preview was asked for; the read runs only after "Preview transfer". */
  const [previewTarget, setPreviewTarget] = useState<string | null>(null);
  const previewQuery = useApiQuery({
    path: '/enrollments/{id}/transfer-preview',
    request: { path: { id: enrollment.id }, query: { targetOfferingId: previewTarget ?? '' } },
    enabled: previewTarget !== null && enrollment.status === 'confirmed',
    staleTime: 0,
  });
  const commitCmd = useApiCommand('post', '/enrollments/{id}/transfer', {
    invalidate: [
      ['api', '/enrollments'],
      ['api', '/enrollments/{id}'],
    ],
  });
  const [acknowledged, setAcknowledged] = useState<FinancialConsequence | null>(null);
  const [changed, setChanged] = useState(false);
  /** The consequence the API answered with a conflict, until the preview read catches up. */
  const [conflicted, setConflicted] = useState<FinancialConsequence | null>(null);
  /**
   * What failed: the confirm-time re-read of the preview (a GET: nothing was sent to change) or
   * the commit itself. They are worded and retried apart.
   */
  const [failure, setFailure] = useState<{ error: ApiError; step: 'preview' | 'commit' } | null>(
    null,
  );
  const [checking, setChecking] = useState(false);
  const [done, setDone] = useState<TransferPreview | null>(null);

  if (done) return <Transferred preview={done} />;
  // Checked after success: once transferred, the refreshed record is no longer confirmed.
  if (enrollment.status !== 'confirmed') {
    return (
      <StateView
        variant="unavailable"
        title="Cannot be transferred"
        description={`Only a confirmed registration can be transferred. This one is ${enrollmentStatus(enrollment).label.toLowerCase()}.`}
      />
    );
  }

  const read =
    previewTarget === targetId ? (previewQuery.data as TransferPreview | undefined) : undefined;
  const preview: TransferPreview | undefined =
    read && conflicted ? { ...read, financialConsequence: conflicted } : read;

  const commit = async (target: string, accepted: FinancialConsequence) => {
    setFailure(null);
    try {
      const body: TransferBody = {
        targetOfferingId: target,
        commit: true,
        acceptedConsequence: acceptedOf(accepted),
        expectedRevision: enrollment.revision,
      };
      setDone((await commitCmd.submit({ path: { id: enrollment.id }, body })) as TransferPreview);
    } catch (error) {
      const apiError = error as ApiError;
      if (consequenceConflict(apiError)) {
        // ENR-03: the consequence changed after it was accepted; nothing was committed. Show the
        // current one (the API sends it) and ask for it to be accepted again.
        const latest = (apiError.details as { consequence?: FinancialConsequence } | undefined)
          ?.consequence;
        setConflicted(latest ?? null);
        setAcknowledged(null);
        setChanged(true);
        commitCmd.reset();
        void previewQuery.refetch();
        return;
      }
      setFailure({ error: apiError, step: 'commit' });
    }
  };

  const confirm = async () => {
    if (!targetId || !preview) return;
    const needsAck = preview.financialConsequence.kind !== 'none';
    if (needsAck && !acknowledged) return;
    // The consequence the customer reviewed: the acknowledged one, or "no money changes".
    const reviewed = acknowledged ?? preview.financialConsequence;
    // Stale version: read the preview again; a changed consequence is never committed unseen
    // (SPK-REG-010, SPK-PAY-008), including "no money changes" that became a charge.
    setChecking(true);
    setFailure(null);
    const result = await previewQuery.refetch();
    setChecking(false);
    if (result.error) {
      // Only the preview read failed: nothing was committed. Its retry repeats the whole check.
      setFailure({ error: result.error, step: 'preview' });
      return;
    }
    const fresh = result.data?.data as TransferPreview | undefined;
    if (!fresh) return;
    setConflicted(null);
    if (!sameConsequence(fresh.financialConsequence, reviewed)) {
      setAcknowledged(null);
      setChanged(true);
      return;
    }
    if (transferBlockers(fresh).length > 0) return;
    await commit(targetId, fresh.financialConsequence);
  };

  const choose = (id: string) => {
    setTargetId(id);
    setAcknowledged(null);
    setChanged(false);
    setConflicted(null);
    setFailure(null);
    commitCmd.reset();
  };

  const choices = (offerings.data?.items ?? []).filter(
    (o: PublicOffering) => o.id !== enrollment.offeringId,
  );
  const blockers = preview ? transferBlockers(preview) : [];
  const needsAck = preview ? preview.financialConsequence.kind !== 'none' : false;
  const summary = preview ? consequenceSummary(preview.financialConsequence) : null;
  const approvalRefused = conflictCode(failure?.error ?? null) === 'APPROVAL_REQUIRED';
  const previewFailed =
    previewTarget === targetId && preview === undefined ? previewQuery.error : null;

  return (
    <View>
      <Section title="Transfer">
        <Field label="Participant" value={nameOf(enrollment.participantPersonId)} />
        <Field
          label="Now in"
          value={enrollment.offering?.name ?? current.data?.name ?? 'Activity no longer listed'}
        />
        <StatusBadge
          {...enrollmentStatus(enrollment, {
            offeringName: enrollment.offering?.name ?? current.data?.name,
          })}
        />
      </Section>

      <Section title="Move to">
        {current.data === undefined && current.error ? (
          // Without the current activity's program there is no list to choose from.
          <QueryErrorView
            error={current.error}
            onRetry={() => void current.refetch()}
            unavailable={{
              title: 'Transfer not available here',
              description: 'Transfers for this activity are handled by the front desk.',
            }}
          />
        ) : (
          <QueryBoundary
            query={offerings}
            label="activities to move to"
            isEmpty={(page) => page.items.every((o) => o.id === enrollment.offeringId)}
            empty={{
              title: 'Nothing to move to',
              description:
                'There is no other published activity in this program right now. The front desk can help with other options.',
            }}
            unavailableOffline={['previewing a transfer', 'transferring']}
          >
            {() => (
              <View accessibilityRole="radiogroup" accessibilityLabel="Activity to move to">
                {choices.map((o) => (
                  <ChoiceRow
                    key={o.id}
                    mode="radio"
                    label={o.name}
                    detail={formatDateRange(o.startsOn, o.endsOn)}
                    checked={targetId === o.id}
                    onPress={() => choose(o.id)}
                  />
                ))}
              </View>
            )}
          </QueryBoundary>
        )}
        <ButtonRow>
          <Button
            label="Preview transfer"
            variant="secondary"
            disabled={!targetId || offline}
            busy={
              previewTarget === targetId &&
              previewQuery.fetchStatus === 'fetching' &&
              !checking &&
              !commitCmd.isProcessing
            }
            onPress={() => {
              if (!targetId) return;
              setConflicted(null);
              if (previewTarget === targetId) void previewQuery.refetch();
              else setPreviewTarget(targetId);
            }}
          />
        </ButtonRow>
        {previewTarget === targetId &&
        preview === undefined &&
        previewQuery.fetchStatus === 'fetching' ? (
          <StateView variant="loading" label="the transfer preview" />
        ) : null}
        {previewFailed ? (
          <CommandFailure
            error={previewFailed}
            what="the transfer preview"
            onRetry={() => void previewQuery.refetch()}
            onReload={reload}
            read
          />
        ) : null}
      </Section>

      {preview ? <PreviewView preview={preview} /> : null}

      {preview ? (
        <Section title="Confirm the transfer">
          {changed ? (
            <StatusBadge
              tone="warning"
              label="The money consequence changed since you reviewed it. Review it again."
              testID="consequence-changed"
            />
          ) : null}
          {blockers.length > 0 ? (
            <StateView
              variant="unavailable"
              title="This transfer cannot be made in the app"
              description={blockers.join(' ')}
            />
          ) : (
            <>
              {needsAck && summary ? (
                <ChoiceRow
                  mode="checkbox"
                  label={`I accept: ${summary.headline}`}
                  checked={acknowledged !== null}
                  onPress={() => {
                    setChanged(false);
                    setAcknowledged(acknowledged ? null : preview.financialConsequence);
                  }}
                />
              ) : null}
              {offline ? <Caption>Needs a connection.</Caption> : null}
              <ButtonRow>
                <Button
                  label="Transfer"
                  onPress={() => void confirm()}
                  disabled={offline || (needsAck && acknowledged === null)}
                  busy={commitCmd.isProcessing || checking}
                  accessibilityHint="Moves the registration with the money consequence shown above"
                />
              </ButtonRow>
            </>
          )}
        </Section>
      ) : null}

      {failure && approvalRefused ? (
        <StateView
          variant="unavailable"
          title="Staff approval needed"
          description="This transfer needs staff approval, so it cannot be made in the app. Ask the front desk to make it; nothing has changed."
        />
      ) : failure?.step === 'preview' ? (
        // The confirm-time re-read of the preview failed: a read, so nothing was sent to change
        // and nothing "may already have been made". "Try again" repeats the whole check (re-read,
        // compare the consequence, blockers) before anything is committed.
        <View testID="transfer-recheck-failed">
          <QueryErrorView
            error={failure.error}
            onRetry={() => void confirm()}
            unavailableOffline={['transferring']}
          />
        </View>
      ) : failure ? (
        <CommandFailure
          error={failure.error}
          what="the transfer"
          onRetry={() => {
            // A commit with no answer repeats the same intent with the same idempotency key.
            if (targetId && acknowledged) void commit(targetId, acknowledged);
            else if (targetId && preview && preview.financialConsequence.kind === 'none')
              void commit(targetId, preview.financialConsequence);
          }}
          onReload={() => {
            setFailure(null);
            setAcknowledged(null);
            commitCmd.reset();
            void previewQuery.refetch();
            reload();
          }}
        />
      ) : null}
    </View>
  );
}

export function TransferEnrollmentScreen({ enrollmentId }: { enrollmentId: string }) {
  const enrollment = useApiQuery({
    path: '/enrollments/{id}',
    request: { path: { id: enrollmentId } },
  });
  return (
    <Screen>
      <RequireSession what="this transfer">
        <QueryBoundary
          query={enrollment}
          label="the enrollment"
          empty={{ title: 'Not available', description: '' }}
          unavailableOffline={['previewing a transfer', 'transferring']}
        >
          {(data) => <TransferForm enrollment={data} reload={() => void enrollment.refetch()} />}
        </QueryBoundary>
      </RequireSession>
    </Screen>
  );
}

/** Route component for app/enrollments/[id]/transfer.tsx. */
export function TransferEnrollmentRoute() {
  const id = param(useLocalSearchParams<{ id: string }>().id);
  return (
    <>
      <Stack.Screen options={{ title: 'Transfer preview' }} />
      {id ? <TransferEnrollmentScreen enrollmentId={id} /> : <NotFoundScreen />}
    </>
  );
}
