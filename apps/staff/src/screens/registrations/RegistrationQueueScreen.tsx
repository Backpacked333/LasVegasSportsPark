/**
 * SCR-S-24 Registration queue and approvals (SPK-REG-002, SPK-REG-003, SPK-REG-007): applications
 * awaiting review with their age, eligibility reasons and required actions; accept or decline
 * (a reason is required) before any payment is captured; an eligibility override needs a reason
 * and is audited. Every command sends `expectedRevision` and an idempotency key per intent (§4.9);
 * STALE_REVISION (for example, the applicant withdrew) offers "Reload".
 *
 * - The approval record stays separate from enrollment, placement and money (SPK-REG-003).
 * - Approval reserves nothing unless an approved policy says so: pending DEC-028/DEC-029.
 * - Who may override eligibility is pending DEC-066: "Override" is offered where the evaluation
 *   failed, and the API decides (ACCESS_DENIED names the missing permission).
 * - The API states no review deadline or resolver per application, so they are shown as not
 *   available rather than invented.
 */
import type { Schema } from '@sportspark/api-client';
import { formatAge } from '@sportspark/api-client';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { CommandError } from '../../features/registration-finance/CommandError';
import { EligibilityView } from '../../features/registration-finance/Eligibility';
import { SelectField, TextArea } from '../../features/registration-finance/fields';
import {
  APPLICATION_STATUS,
  REGISTRATION_INTENT,
  applicationDecidable,
} from '../../features/registration-finance/labels';
import { OfferingName, PersonName } from '../../features/registration-finance/names';
import { OfflineCaption, useOnline } from '../../features/registration-finance/offline';
import { PENDING } from '../../features/registration-finance/pending';
import { REGISTRATION_LINKS, SectionNav } from '../../features/registration-finance/SectionNav';
import { useNow } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';

type Application = Schema<'Application'>;
type ApplicationStatus = Schema<'ApplicationStatus'>;

const QUEUE_KEY = ['api', '/applications'] as const;

type Mode = 'idle' | 'decline' | 'override';

function ApplicationCard({ application }: { application: Application }) {
  const online = useOnline();
  const now = useNow();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<Mode>('idle');
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | null>(null);
  const accept = useApiCommand('post', '/applications/{id}/accept', { invalidate: [QUEUE_KEY] });
  const decline = useApiCommand('post', '/applications/{id}/decline', { invalidate: [QUEUE_KEY] });
  const override = useApiCommand('post', '/applications/{id}/override-eligibility', {
    invalidate: [QUEUE_KEY],
  });
  const [last, setLast] = useState<'accept' | 'decline' | 'override' | null>(null);
  const active =
    last === 'accept'
      ? accept
      : last === 'decline'
        ? decline
        : last === 'override'
          ? override
          : null;
  const decidable = applicationDecidable(application.status);
  const failed = application.eligibility !== null && !application.eligibility.eligible;
  const canOverride = decidable && failed && application.override === null;
  const busy = accept.isProcessing || decline.isProcessing || override.isProcessing;
  const subject = application.id;

  const reload = () => {
    accept.reset();
    decline.reset();
    override.reset();
    void queryClient.invalidateQueries({ queryKey: QUEUE_KEY });
  };
  const doAccept = () => {
    setLast('accept');
    accept
      .submit({ path: { id: application.id }, body: { expectedRevision: application.revision } })
      .catch(() => undefined);
  };
  const doWithReason = () => {
    if (reason.trim() === '') {
      setReasonError('A reason is required and is kept in the audit history.');
      return;
    }
    setReasonError(null);
    const command = mode === 'decline' ? decline : override;
    setLast(mode === 'decline' ? 'decline' : 'override');
    command
      .submit({
        path: { id: application.id },
        body: { expectedRevision: application.revision, reason: reason.trim() },
      })
      .then(() => {
        setMode('idle');
        setReason('');
      })
      .catch(() => undefined);
  };

  return (
    <li aria-labelledby={`application-${subject}`}>
      <div className="row-text">
        <span className="row-title" id={`application-${subject}`}>
          <PersonName id={application.participantPersonId} fallback="Participant" />:{' '}
          <OfferingName id={application.offeringId} />
        </span>
        <span className="caption">
          {REGISTRATION_INTENT[application.intent]} · submitted{' '}
          {application.submittedAt ? formatAge(new Date(application.submittedAt), now) : 'not yet'}{' '}
          by {application.submittedBy.actorLabel} ({application.submittedBy.kind})
          {application.requiresApproval ? ' · approval required before payment' : ''}
        </span>
        <span className="caption">
          Review deadline and resolver: not available (the API does not state them).
        </span>
        <StatusBadge {...APPLICATION_STATUS[application.status]} />
        <EligibilityView
          result={application.eligibility}
          override={application.override}
          label="Eligibility"
        />
        {application.decisionReason ? (
          <span className="caption">Decision reason: {application.decisionReason}</span>
        ) : null}
      </div>
      {decidable ? (
        <div className="rf-actions">
          <Button busy={accept.isProcessing} disabled={!online || busy} onClick={doAccept}>
            Approve
          </Button>
          <Button variant="secondary" disabled={!online || busy} onClick={() => setMode('decline')}>
            Decline…
          </Button>
          {canOverride ? (
            <Button
              variant="secondary"
              disabled={!online || busy}
              onClick={() => setMode('override')}
            >
              Override eligibility…
            </Button>
          ) : null}
        </div>
      ) : null}
      {mode !== 'idle' ? (
        <form
          noValidate
          aria-label={mode === 'decline' ? 'Decline the application' : 'Override eligibility'}
          onSubmit={(event) => {
            event.preventDefault();
            doWithReason();
          }}
        >
          {mode === 'override' ? (
            <p className="caption">
              Overrides need specific authority, a reason and audit history (SPK-REG-002). Which
              roles hold that authority is pending {PENDING.overrideAuthority.ids.join(', ')}{' '}
              (owner: {PENDING.overrideAuthority.owner}); the API decides.
            </p>
          ) : null}
          <TextArea
            label={mode === 'decline' ? 'Reason for declining' : 'Reason for the override'}
            required
            value={reason}
            onChange={setReason}
            error={reasonError}
          />
          <div className="rf-actions">
            <Button type="submit" busy={busy} disabled={!online}>
              {mode === 'decline' ? 'Decline the application' : 'Override eligibility'}
            </Button>
            <Button variant="secondary" onClick={() => setMode('idle')}>
              Cancel
            </Button>
          </div>
        </form>
      ) : null}
      <OfflineCaption action="approving or declining" />
      {active?.status === 'success' && active.data ? (
        <p role="status">Application now {APPLICATION_STATUS[active.data.status].label}.</p>
      ) : null}
      <CommandError error={active?.error} onReload={reload} />
    </li>
  );
}

const STATUS_FILTERS: readonly ApplicationStatus[] = [
  'awaiting_review',
  'submitted',
  'accepted',
  'declined',
  'withdrawn',
];

export function RegistrationQueueScreen() {
  const [status, setStatus] = useState<ApplicationStatus | ''>('awaiting_review');
  const applications = useApiQuery({
    path: '/applications',
    request: { query: { limit: 200, ...(status ? { status } : {}) } },
  });
  return (
    <section aria-labelledby="queue-title">
      <h2 id="queue-title">Registration queue and approvals</h2>
      <SectionNav label="Registrations and waitlists" links={REGISTRATION_LINKS} />
      <p className="caption">
        Approval comes before any payment is captured, and it reserves no place unless an approved
        policy says so: pending {PENDING.approvals.ids.join(', ')} (owner: {PENDING.approvals.owner}
        ).
      </p>
      <SelectField
        label="Applications"
        value={status}
        placeholder="All statuses"
        onChange={(v) => setStatus(v as ApplicationStatus | '')}
        options={STATUS_FILTERS.map((s) => ({ value: s, label: APPLICATION_STATUS[s].label }))}
      />
      <QueryBoundary
        query={applications}
        label="applications"
        isEmpty={(page) => page.items.length === 0}
        empty={{
          title: status === 'awaiting_review' ? 'Queue clear' : 'No applications',
          description:
            status === 'awaiting_review'
              ? 'No application is waiting for review.'
              : 'No application has this status.',
        }}
        unavailableOffline={['approving, declining or overriding']}
      >
        {(page) => (
          <>
            <ul className="list" aria-label="Applications">
              {page.items.map((application) => (
                <ApplicationCard key={application.id} application={application} />
              ))}
            </ul>
            {page.nextCursor ? (
              <StateView
                variant="empty"
                title="More applications exist"
                description="Only the first 200 are shown."
              />
            ) : null}
          </>
        )}
      </QueryBoundary>
    </section>
  );
}
