/**
 * SCR-S-27 Cancellation and transfer (staff) (SPK-REG-010, SPK-PAY-008, SPK-PAY-009, §4.8
 * `POST /v1/enrollments/{id}/transfer`): before any commitment the screen shows the existing and
 * proposed participation, affected dates, capacity implications, the refund, credit or charge and
 * whether approval is required, all as the API computed them. Cancelling needs a reason; a
 * transfer whose consequence is not "none" needs the customer's acceptance to be confirmed.
 * Both send `expectedRevision` and an idempotency key per intent (§4.9).
 *
 * - A transfer links the old and new enrollments; attendance stays on the original (SPK-REG-010).
 * - STALE_REVISION or CAPACITY_UNAVAILABLE means the record or capacity changed: re-preview.
 * - REFUND_PENDING is a recovery state: a refund already reserves the funds (SPK-PAY-008).
 * - Refund, credit and transfer rules are pending DEC-009 (owner Finance); the API's consequence
 *   and its explanation are shown as given, never recomputed here.
 */
import type { Schema } from '@sportspark/api-client';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { CommandError } from '../../features/registration-finance/CommandError';
import { EligibilityView } from '../../features/registration-finance/Eligibility';
import { CheckboxField, Facts, TextArea } from '../../features/registration-finance/fields';
import {
  formatDate,
  formatInstant,
  formatMoney,
  shortRef,
} from '../../features/registration-finance/format';
import {
  CAPACITY_UNIT,
  CONSEQUENCE_KIND,
  ENROLLMENT_STATUS,
  REGISTRATION_INTENT,
} from '../../features/registration-finance/labels';
import { OfferingName, PersonName } from '../../features/registration-finance/names';
import { OfferingPicker } from '../../features/registration-finance/OfferingPicker';
import { OfflineCaption, useOnline } from '../../features/registration-finance/offline';
import { PENDING } from '../../features/registration-finance/pending';
import { REGISTRATION_LINKS, SectionNav } from '../../features/registration-finance/SectionNav';
import { Button } from '../../ui/Button';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';

type Enrollment = Schema<'Enrollment'>;
type Consequence = NonNullable<Schema<'FinancialConsequence'>>;

const ENROLLMENT_KEY = ['api', '/enrollments/{id}'] as const;

export function ConsequenceView({ consequence }: { consequence: Consequence | null }) {
  if (!consequence) {
    return <StatusBadge tone="pending" label="Financial consequence not stated" />;
  }
  return (
    <div className="row-text" role="group" aria-label="Financial consequence">
      <span>
        <StatusBadge {...CONSEQUENCE_KIND[consequence.kind]} />{' '}
        {consequence.amountMinor !== null
          ? formatMoney(consequence.amountMinor, consequence.currency)
          : null}
      </span>
      <span>{consequence.explanation}</span>
      <span className="caption">
        Policy {consequence.policyVersionId ? shortRef(consequence.policyVersionId) : 'none'}. Rules
        pending {PENDING.refundsCreditsCash.ids[0]} (owner: {PENDING.refundsCreditsCash.owner}).
      </span>
    </div>
  );
}

function Participation({
  label,
  summary,
}: {
  label: string;
  summary: Schema<'ParticipationSummary'>;
}) {
  return (
    <Facts
      label={label}
      items={[
        [label, summary.offeringName],
        ['Dates', `${formatDate(summary.startsOn)} to ${formatDate(summary.endsOn)}`],
        [
          'Price basis',
          summary.price
            ? formatMoney(summary.price.basePriceMinor, summary.price.currency)
            : 'Not priced',
        ],
      ]}
    />
  );
}

function CancelSection({ enrollment }: { enrollment: Enrollment }) {
  const online = useOnline();
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | null>(null);
  const preview = useApiQuery({
    path: '/enrollments/{id}/cancellation-preview',
    request: { path: { id: enrollment.id } },
  });
  const cancel = useApiCommand('post', '/enrollments/{id}/cancel', {
    invalidate: [
      ENROLLMENT_KEY,
      ['api', '/enrollments/{id}/cancellation-preview'],
      ['api', '/enrollments'],
    ],
  });
  const reload = () => {
    cancel.reset();
    void queryClient.invalidateQueries({ queryKey: ENROLLMENT_KEY });
    void queryClient.invalidateQueries({
      queryKey: ['api', '/enrollments/{id}/cancellation-preview'],
    });
  };
  return (
    <section className="rf-panel" aria-labelledby="cancel-title">
      <h3 id="cancel-title">Cancel</h3>
      <QueryBoundary
        query={preview}
        label="the cancellation preview"
        empty={{ title: '', description: '' }}
        unavailableOffline={['canceling']}
      >
        {(data) => (
          <>
            <Participation label="Existing participation" summary={data.existing} />
            <Facts
              label="Cancellation preview"
              items={[
                [
                  'Affected dates',
                  `${formatDate(data.affectedDates.startsOn)} to ${formatDate(data.affectedDates.endsOn)}`,
                ],
                [
                  'Capacity released',
                  data.capacity.released.length === 0
                    ? 'None'
                    : data.capacity.released
                        .map((r) => `${r.quantity} ${CAPACITY_UNIT[r.unit]}`)
                        .join(', '),
                ],
                ['Approval required', data.requiredApproval ? 'Yes' : 'No'],
                ['Permitted by the cancellation policy', data.permitted ? 'Yes' : 'No'],
              ]}
            />
            <ConsequenceView consequence={data.financialConsequence} />
            {data.permitted ? (
              <form
                noValidate
                aria-label="Cancel the enrollment"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!reason.trim()) {
                    setReasonError('A reason is required and is audited.');
                    return;
                  }
                  setReasonError(null);
                  cancel
                    .submit({
                      path: { id: enrollment.id },
                      body: { reason: reason.trim(), expectedRevision: enrollment.revision },
                    })
                    .catch(() => undefined);
                }}
              >
                <TextArea
                  label="Reason for canceling"
                  required
                  value={reason}
                  onChange={setReason}
                  error={reasonError}
                />
                <div className="rf-actions">
                  <Button type="submit" busy={cancel.isProcessing} disabled={!online}>
                    Cancel the enrollment
                  </Button>
                </div>
              </form>
            ) : (
              <p>The cancellation policy does not permit canceling this enrollment now.</p>
            )}
          </>
        )}
      </QueryBoundary>
      <OfflineCaption action="canceling" />
      {cancel.status === 'success' && cancel.data ? (
        <p role="status">Enrollment now {ENROLLMENT_STATUS[cancel.data.status].label}.</p>
      ) : null}
      <CommandError error={cancel.error} onReload={reload} />
    </section>
  );
}

function TransferPreviewView({ preview }: { preview: Schema<'TransferPreview'> }) {
  return (
    <div role="group" aria-label="Transfer preview">
      <Participation label="Existing participation" summary={preview.existing} />
      <Participation label="Proposed participation" summary={preview.proposed} />
      <Facts
        label="Transfer implications"
        items={[
          [
            'Affected dates',
            `${formatDate(preview.affectedDates.existingRange.startsOn)} to ${formatDate(preview.affectedDates.existingRange.endsOn)}, then ${formatDate(preview.affectedDates.proposedRange.startsOn)} to ${formatDate(preview.affectedDates.proposedRange.endsOn)}${preview.affectedDates.overlapping ? ' (overlapping)' : ''}`,
          ],
          [
            'Capacity released',
            preview.capacity.released.length === 0
              ? 'None'
              : preview.capacity.released.map((r) => CAPACITY_UNIT[r.unit]).join(', '),
          ],
          [
            'Capacity required',
            preview.capacity.required.length === 0
              ? 'None'
              : preview.capacity.required
                  .map(
                    (r) =>
                      `${CAPACITY_UNIT[r.unit]} (${r.constraintKind}): ${r.available} available`,
                  )
                  .join(', '),
          ],
          ['Waiting ahead on the target waitlist', String(preview.capacity.waitlistAhead)],
          ['Capacity sufficient', preview.capacity.sufficient ? 'Yes' : 'No'],
          ['Approval required', preview.requiredApproval ? 'Yes' : 'No'],
        ]}
      />
      <EligibilityView result={preview.eligibility} label="Eligibility for the proposed offering" />
      <ConsequenceView consequence={preview.financialConsequence} />
    </div>
  );
}

function TransferSection({ enrollment }: { enrollment: Enrollment }) {
  const online = useOnline();
  const queryClient = useQueryClient();
  const [target, setTarget] = useState('');
  const [accepted, setAccepted] = useState(false);
  const previewCommand = useApiCommand('post', '/enrollments/{id}/transfer');
  const commit = useApiCommand('post', '/enrollments/{id}/transfer', {
    invalidate: [ENROLLMENT_KEY, ['api', '/enrollments']],
  });
  const preview =
    previewCommand.data && !previewCommand.data.committed ? previewCommand.data : null;
  // A consequence the API does not state is treated as needing the customer's acceptance.
  const needsAcceptance = preview !== null && preview.financialConsequence?.kind !== 'none';
  const runPreview = () => {
    commit.reset();
    setAccepted(false);
    previewCommand
      .submit({
        path: { id: enrollment.id },
        body: {
          targetOfferingId: target,
          commit: false,
          acceptConsequence: false,
          expectedRevision: enrollment.revision,
        },
      })
      .catch(() => undefined);
  };
  const reload = () => {
    commit.reset();
    previewCommand.reset();
    void queryClient.invalidateQueries({ queryKey: ENROLLMENT_KEY });
  };
  return (
    <section className="rf-panel" aria-labelledby="transfer-title">
      <h3 id="transfer-title">Transfer</h3>
      <OfferingPicker
        label="Transfer to"
        value={target}
        excludeId={enrollment.offeringId}
        onChange={(id) => {
          setTarget(id);
          previewCommand.reset();
          commit.reset();
        }}
      />
      <div className="rf-actions">
        <Button
          busy={previewCommand.isProcessing}
          disabled={!online || !target}
          onClick={runPreview}
        >
          Preview the transfer
        </Button>
      </div>
      <CommandError error={previewCommand.error} onReload={reload} />
      {preview ? (
        <>
          <TransferPreviewView preview={preview} />
          {needsAcceptance ? (
            <CheckboxField
              label="The customer accepted the financial consequence shown"
              checked={accepted}
              onChange={setAccepted}
            />
          ) : null}
          <div className="rf-actions">
            <Button
              busy={commit.isProcessing}
              disabled={!online || (needsAcceptance && !accepted)}
              onClick={() => {
                commit
                  .submit({
                    path: { id: enrollment.id },
                    body: {
                      targetOfferingId: target,
                      commit: true,
                      acceptConsequence: needsAcceptance && accepted,
                      expectedRevision: enrollment.revision,
                    },
                  })
                  .catch(() => undefined);
              }}
            >
              Transfer the enrollment
            </Button>
          </div>
        </>
      ) : null}
      <OfflineCaption action="transferring" />
      {commit.data?.committed ? (
        <p role="status">
          Transferred. The new enrollment is{' '}
          {commit.data.newEnrollment ? (
            <Link to={`/registrations/enrollments/${commit.data.newEnrollment.id}`}>
              {ENROLLMENT_STATUS[commit.data.newEnrollment.status].label}
            </Link>
          ) : (
            'linked'
          )}
          ; attendance history stays on this one.
        </p>
      ) : null}
      <CommandError error={commit.error} onReload={reload} />
    </section>
  );
}

function EnrollmentView({ enrollment }: { enrollment: Enrollment }) {
  const cancelable = enrollment.status === 'pending' || enrollment.status === 'confirmed';
  return (
    <>
      <h3>
        <PersonName id={enrollment.participantPersonId} fallback="Participant" />:{' '}
        <OfferingName id={enrollment.offeringId} />
      </h3>
      <p>
        <StatusBadge {...ENROLLMENT_STATUS[enrollment.status]} />
      </p>
      <Facts
        label="Enrollment"
        items={[
          ['Intent', REGISTRATION_INTENT[enrollment.intent]],
          [
            'Registered by',
            `${enrollment.registeredBy.actorLabel} (${enrollment.registeredBy.kind})`,
          ],
          ['Payer', <PersonName key="payer" id={enrollment.payerPersonId} fallback="Payer" />],
          [
            'Price basis',
            enrollment.price
              ? formatMoney(enrollment.price.basePriceMinor, enrollment.price.currency)
              : 'Not priced',
          ],
          ['Confirmed', formatInstant(enrollment.confirmedAt)],
          ['Revision', String(enrollment.revision)],
        ]}
      />
      {enrollment.transferredFromEnrollmentId ? (
        <p>
          Transferred from{' '}
          <Link to={`/registrations/enrollments/${enrollment.transferredFromEnrollmentId}`}>
            the earlier enrollment
          </Link>
          .
        </p>
      ) : null}
      {enrollment.transferredToEnrollmentId ? (
        <p>
          Transferred to{' '}
          <Link to={`/registrations/enrollments/${enrollment.transferredToEnrollmentId}`}>
            the new enrollment
          </Link>{' '}
          on {formatInstant(enrollment.transferredAt)}. Attendance history stays here.
        </p>
      ) : null}
      {enrollment.status === 'canceled' ? (
        <section className="rf-panel" aria-label="Cancellation">
          <p>
            Canceled {formatInstant(enrollment.canceledAt)}: {enrollment.cancellationReason}
          </p>
          {enrollment.cancellationConsequence ? (
            <ConsequenceView consequence={enrollment.cancellationConsequence} />
          ) : null}
        </section>
      ) : null}
      {cancelable ? <CancelSection enrollment={enrollment} /> : null}
      {enrollment.status === 'confirmed' ? <TransferSection enrollment={enrollment} /> : null}
      {!cancelable ? (
        <StateView
          variant="empty"
          title="No change available"
          description={`A ${ENROLLMENT_STATUS[enrollment.status].label} enrollment cannot be canceled or transferred.`}
        />
      ) : null}
    </>
  );
}

export function EnrollmentChangeScreen() {
  const { enrollmentId = '' } = useParams();
  const enrollment = useApiQuery({
    path: '/enrollments/{id}',
    request: { path: { id: enrollmentId } },
  });
  return (
    <section aria-labelledby="enrollment-title">
      {/* SPK-UX-009: the region keeps its name and the area navigation in every state. */}
      <h2 id="enrollment-title">Enrollment</h2>
      <SectionNav label="Registrations and waitlists" links={REGISTRATION_LINKS} />
      <QueryBoundary
        query={enrollment}
        label="the enrollment"
        empty={{ title: '', description: '' }}
        unavailableOffline={['canceling', 'transferring']}
      >
        {(data) => <EnrollmentView enrollment={data} />}
      </QueryBoundary>
    </section>
  );
}
