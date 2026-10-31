/**
 * SCR-S-27 Cancellation and transfer (staff) (SPK-REG-010, SPK-PAY-008, SPK-PAY-009, §4.8
 * `POST /v1/enrollments/{id}/transfer`): before any commitment the screen shows the existing and
 * proposed participation, affected dates, capacity implications, the refund, credit or charge and
 * whether approval is required, all as the API computed them (`GET .../cancellation-preview`,
 * `GET .../transfer-preview`, read-only). Cancelling needs a reason; a consequence that is not
 * "none" needs the customer's acceptance, and the consequence the customer accepted (a snapshot
 * taken when the box is ticked, never a later re-read of the preview) is sent back as
 * `acceptedConsequence` (ENR-03): a re-read that shows a different consequence unticks the box,
 * and when it changed on the server in between, the API commits nothing and the screen shows the
 * current one to accept again. Both commands send `expectedRevision` and an
 * idempotency key per intent (§4.9).
 *
 * - A transfer links the old and new enrollments; attendance stays on the original (SPK-REG-010).
 * - STALE_REVISION or CAPACITY_UNAVAILABLE means the record or capacity changed: re-preview.
 * - REFUND_PENDING is a recovery state: a refund already reserves the funds (SPK-PAY-008).
 * - Refund, credit and transfer rules are pending DEC-009 (owner Finance); the API's consequence
 *   and its explanation are shown as given, never recomputed here.
 * - Package G: a membership enrollment offers suspensions (ENR-12, `memberships`), a package
 *   purchase lists its session package with redemption reversal (ENR-11, `session_packages`);
 *   neither is turned off by the API, so both show the switch as a notice (DEC-016).
 * - Times are in the offering facility's zone the enrollment names (SPK-SCHED-008).
 */
import type { Schema } from '@sportspark/api-client';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { CommandError } from '../../features/registration-finance/CommandError';
import { EligibilityView } from '../../features/registration-finance/Eligibility';
import {
  AcceptanceOutdated,
  ConsequenceConflict,
  ConsequenceView,
  consequenceConflictOf,
  useAcceptance,
} from '../../features/registration-finance/consequence';
import { CheckboxField, Facts, TextArea } from '../../features/registration-finance/fields';
import { formatDate, formatInstant, formatMoney } from '../../features/registration-finance/format';
import {
  CAPACITY_UNIT,
  ENROLLMENT_STATUS,
  REGISTRATION_INTENT,
} from '../../features/registration-finance/labels';
import { MembershipSuspensionPanel } from '../../features/registration-finance/MembershipSuspensions';
import { PackageEntitlementList } from '../../features/registration-finance/PackageEntitlements';
import { OfferingName, PersonName } from '../../features/registration-finance/names';
import { OfferingPicker } from '../../features/registration-finance/OfferingPicker';
import { OfflineCaption, useOnline } from '../../features/registration-finance/offline';
import { REGISTRATION_LINKS, SectionNav } from '../../features/registration-finance/SectionNav';
import { Button } from '../../ui/Button';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';

type Enrollment = Schema<'Enrollment'>;
const ENROLLMENT_KEY = ['api', '/enrollments/{id}'] as const;

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
  // ENR-03: the acceptance is bound to the consequence the customer saw, not to later re-reads.
  const acceptance = useAcceptance(preview.data?.financialConsequence ?? null);
  const cancel = useApiCommand('post', '/enrollments/{id}/cancel', {
    invalidate: [
      ENROLLMENT_KEY,
      ['api', '/enrollments/{id}/cancellation-preview'],
      ['api', '/enrollments'],
    ],
  });
  const conflict = consequenceConflictOf(cancel.error);
  const previewAgain = () => {
    cancel.reset();
    acceptance.clear();
    void queryClient.invalidateQueries({
      queryKey: ['api', '/enrollments/{id}/cancellation-preview'],
    });
  };
  const reload = () => {
    previewAgain();
    void queryClient.invalidateQueries({ queryKey: ENROLLMENT_KEY });
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
        {(data) => {
          const consequence = data.financialConsequence ?? null;
          const { mustAccept } = acceptance;
          return (
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
              <ConsequenceView consequence={consequence} />
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
                    const acceptedConsequence = acceptance.toSend();
                    if (!acceptedConsequence) return;
                    cancel
                      .submit({
                        path: { id: enrollment.id },
                        body: {
                          reason: reason.trim(),
                          expectedRevision: enrollment.revision,
                          acceptedConsequence,
                        },
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
                  {consequence && mustAccept ? (
                    <CheckboxField
                      label="The customer accepted the financial consequence shown"
                      checked={acceptance.checked}
                      onChange={acceptance.setChecked}
                    />
                  ) : null}
                  {consequence && mustAccept && acceptance.outdated ? <AcceptanceOutdated /> : null}
                  {!consequence ? (
                    <p>The API did not state the financial consequence: preview again first.</p>
                  ) : null}
                  <div className="rf-actions">
                    <Button
                      type="submit"
                      busy={cancel.isProcessing}
                      disabled={!online || !consequence || (mustAccept && !acceptance.checked)}
                    >
                      Cancel the enrollment
                    </Button>
                  </div>
                </form>
              ) : (
                <p>The cancellation policy does not permit canceling this enrollment now.</p>
              )}
            </>
          );
        }}
      </QueryBoundary>
      <OfflineCaption action="canceling" />
      {cancel.status === 'success' && cancel.data ? (
        <p role="status">Enrollment now {ENROLLMENT_STATUS[cancel.data.status].label}.</p>
      ) : null}
      {conflict && cancel.error ? (
        <ConsequenceConflict
          conflict={conflict}
          error={cancel.error}
          onPreviewAgain={previewAgain}
        />
      ) : (
        <CommandError error={cancel.error} onReload={reload} />
      )}
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
  // ENR-03: the read-only preview (a GET), so a stale preview is never replayed by a POST.
  const preview = useApiQuery({
    path: '/enrollments/{id}/transfer-preview',
    request: { path: { id: enrollment.id }, query: { targetOfferingId: target } },
    enabled: target !== '',
  });
  // ENR-03: the acceptance is bound to the consequence the customer saw, not to later re-reads.
  const acceptance = useAcceptance(target ? (preview.data?.financialConsequence ?? null) : null);
  const commit = useApiCommand('post', '/enrollments/{id}/transfer', {
    invalidate: [ENROLLMENT_KEY, ['api', '/enrollments']],
  });
  const conflict = consequenceConflictOf(commit.error);
  const previewAgain = () => {
    commit.reset();
    acceptance.clear();
    void queryClient.invalidateQueries({ queryKey: ['api', '/enrollments/{id}/transfer-preview'] });
  };
  const reload = () => {
    previewAgain();
    void queryClient.invalidateQueries({ queryKey: ENROLLMENT_KEY });
  };
  const committed = commit.data?.committed ? commit.data : null;
  return (
    <section className="rf-panel" aria-labelledby="transfer-title">
      <h3 id="transfer-title">Transfer</h3>
      <OfferingPicker
        label="Transfer to"
        value={target}
        excludeId={enrollment.offeringId}
        onChange={(id) => {
          setTarget(id);
          acceptance.clear();
          commit.reset();
        }}
      />
      {target && !committed ? (
        <QueryBoundary
          query={preview}
          label="the transfer preview"
          empty={{ title: '', description: '' }}
          unavailableOffline={['transferring']}
        >
          {(data) => {
            const consequence = data.financialConsequence ?? null;
            const { mustAccept } = acceptance;
            return (
              <>
                <TransferPreviewView preview={data} />
                {consequence && mustAccept ? (
                  <CheckboxField
                    label="The customer accepted the financial consequence shown"
                    checked={acceptance.checked}
                    onChange={acceptance.setChecked}
                  />
                ) : null}
                {consequence && mustAccept && acceptance.outdated ? <AcceptanceOutdated /> : null}
                <div className="rf-actions">
                  <Button
                    busy={commit.isProcessing}
                    disabled={!online || !consequence || (mustAccept && !acceptance.checked)}
                    onClick={() => {
                      const acceptedConsequence = acceptance.toSend();
                      if (!acceptedConsequence) return;
                      commit
                        .submit({
                          path: { id: enrollment.id },
                          body: {
                            targetOfferingId: target,
                            commit: true,
                            acceptedConsequence,
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
            );
          }}
        </QueryBoundary>
      ) : null}
      <OfflineCaption action="transferring" />
      {committed ? (
        <p role="status">
          Transferred. The new enrollment is{' '}
          {committed.newEnrollment ? (
            <Link to={`/registrations/enrollments/${committed.newEnrollment.id}`}>
              {ENROLLMENT_STATUS[committed.newEnrollment.status].label}
            </Link>
          ) : (
            'linked'
          )}
          ; attendance history stays on this one.
        </p>
      ) : null}
      {conflict && commit.error ? (
        <ConsequenceConflict
          conflict={conflict}
          error={commit.error}
          onPreviewAgain={previewAgain}
        />
      ) : (
        <CommandError error={commit.error} onReload={reload} />
      )}
    </section>
  );
}

function EnrollmentView({ enrollment }: { enrollment: Enrollment }) {
  const cancelable = enrollment.status === 'pending' || enrollment.status === 'confirmed';
  // SPK-SCHED-008: the enrollment names its offering's facility zone (ENR-02).
  const zone = enrollment.offering?.timezone ?? null;
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
          ['Confirmed', formatInstant(enrollment.confirmedAt, zone)],
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
          on {formatInstant(enrollment.transferredAt, zone)}. Attendance history stays here.
        </p>
      ) : null}
      {enrollment.status === 'canceled' ? (
        <section className="rf-panel" aria-label="Cancellation">
          <p>
            Canceled {formatInstant(enrollment.canceledAt, zone)}: {enrollment.cancellationReason}
          </p>
          {enrollment.cancellationConsequence ? (
            <ConsequenceView consequence={enrollment.cancellationConsequence} />
          ) : null}
        </section>
      ) : null}
      {enrollment.intent === 'membership' ? (
        <MembershipSuspensionPanel enrollment={enrollment} zone={zone} />
      ) : null}
      {enrollment.intent === 'package_purchase' ? (
        <PackageEntitlementList
          title="Session package"
          filter={{
            participantPersonId: enrollment.participantPersonId,
            offeringId: enrollment.offeringId,
          }}
          enrollmentId={enrollment.id}
          zone={zone}
        />
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
