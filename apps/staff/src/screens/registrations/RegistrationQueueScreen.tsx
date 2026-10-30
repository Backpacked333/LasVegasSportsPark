/**
 * SCR-S-24 Registration queue and approvals (SPK-REG-002, SPK-REG-003, SPK-REG-007): applications
 * awaiting review with their age, eligibility reasons and required actions; accept or decline
 * (a reason is required) before any payment is captured; an eligibility override needs a reason
 * and is audited. Every command sends `expectedRevision` and an idempotency key per intent (§4.9);
 * STALE_REVISION (for example, the applicant withdrew) offers "Reload".
 *
 * - The approval record stays separate from enrollment, placement and money (SPK-REG-003).
 * - Approval reserves nothing unless an approved policy says so: pending DEC-028/DEC-029.
 * - The default queue is every application waiting for a decision: `awaiting_review` (eligible)
 *   and `submitted` (the API keeps an application that failed eligibility in `submitted`).
 * - Who may override eligibility is pending DEC-066: "Override" is offered on a submitted
 *   application whose evaluation failed (the only state the API accepts it from), and the API
 *   decides (ACCESS_DENIED names the missing permission). Approve is not offered on an ineligible
 *   application without an override.
 * - Lists are the API's keyset pages (`GET /v1/applications`, newest first, ENR-02) with "Load
 *   more", shown in that order and labelled so: the default view lists the two waiting states
 *   apart, each newest first, and never re-sorts a partial set (older applications follow under
 *   "Load more"; the API offers no oldest-first order).
 * - Review deadlines are pending DEC-028 (the API states none), so none is invented. Who may
 *   decide is the API's: the permission names and whether this principal holds them come from
 *   `GET /v1/me/permissions`; the API states no named resolver per application.
 */
import type { Schema } from '@sportspark/api-client';
import { formatAge } from '@sportspark/api-client';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useApiCommand } from '../../api/useApiCommand';
import { usePermissions } from '../../api/permissions';
import { useApiPages } from '../../api/useApiPages';
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
import { LoadMore } from '../../ui/LoadMore';
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
  const canOverride = application.status === 'submitted' && failed && application.override === null;
  const canApprove = decidable && (!failed || application.override !== null);
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
          Review deadline: pending {PENDING.reviewDeadline.ids.join(', ')} (none is set). Resolver:
          not stated per application.
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
        // Each button is described by its row title, so a screen reader names the application it
        // acts on (SPK-UX-009).
        <div className="rf-actions">
          {canApprove ? (
            <Button
              busy={accept.isProcessing}
              disabled={!online || busy}
              onClick={doAccept}
              aria-describedby={`application-${subject}`}
            >
              Approve
            </Button>
          ) : null}
          <Button
            variant="secondary"
            disabled={!online || busy}
            onClick={() => setMode('decline')}
            aria-describedby={`application-${subject}`}
          >
            Decline…
          </Button>
          {canOverride ? (
            <Button
              variant="secondary"
              disabled={!online || busy}
              onClick={() => setMode('override')}
              aria-describedby={`application-${subject}`}
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

/** The default filter: every application waiting for a decision. */
const NEEDS_DECISION = 'needs_decision';
type Filter = ApplicationStatus | typeof NEEDS_DECISION | '';

function ApplicationList({
  items,
  label = 'Applications',
}: {
  items: readonly Application[];
  label?: string;
}) {
  return (
    <ul className="list" aria-label={label}>
      {items.map((application) => (
        <ApplicationCard key={application.id} application={application} />
      ))}
    </ul>
  );
}

const WAITING: readonly {
  status: 'awaiting_review' | 'submitted';
  title: string;
  label: string;
  description: string;
  none: string;
}[] = [
  {
    status: 'awaiting_review',
    title: 'Awaiting review',
    label: 'Applications awaiting review',
    description: 'Eligible applications waiting for approval or decline.',
    none: 'No eligible application is awaiting review.',
  },
  {
    status: 'submitted',
    title: 'Submitted, eligibility not met',
    label: 'Submitted applications',
    description:
      'Applications the API keeps in submitted (eligibility failed or not yet evaluated): decline, or override eligibility.',
    none: 'No submitted application is waiting for a decision.',
  },
];

/**
 * One waiting state in the API's order (newest first, ENR-02) with "Load more": the list is never
 * re-sorted, because a re-sorted first page would put the oldest loaded application on top while
 * older ones are still on pages not loaded (the API offers no oldest-first order).
 */
function WaitingList({ state }: { state: (typeof WAITING)[number] }) {
  const pages = useApiPages({
    path: '/applications',
    request: { query: { limit: 50, status: state.status } },
  });
  const id = `queue-${state.status}`;
  return (
    <section className="rf-panel" aria-labelledby={id}>
      <h3 id={id}>{state.title}</h3>
      <p className="caption">
        {state.description} Newest first, as the API lists them
        {pages.hasNextPage ? '; older applications follow under “Load more”' : ''}.
      </p>
      <QueryBoundary
        query={pages}
        label={state.label.toLowerCase()}
        isEmpty={(items) => items.length === 0}
        empty={{
          title: 'None waiting',
          description: state.none,
        }}
        unavailableOffline={['approving, declining or overriding']}
      >
        {(items) => <ApplicationList items={items} label={state.label} />}
      </QueryBoundary>
      <LoadMore pages={pages} label={state.label.toLowerCase()} />
    </section>
  );
}

/** Every application waiting for a decision: the API's two waiting states, each in its order. */
function DecisionQueue() {
  const awaiting = useApiPages({
    path: '/applications',
    request: { query: { limit: 50, status: 'awaiting_review' } },
  });
  const submitted = useApiPages({
    path: '/applications',
    request: { query: { limit: 50, status: 'submitted' } },
  });
  // Shares the cache entries the two lists read: "Queue clear" only when both answered empty.
  const clear =
    awaiting.data?.length === 0 &&
    !awaiting.hasNextPage &&
    submitted.data?.length === 0 &&
    !submitted.hasNextPage;
  if (clear) {
    return (
      <StateView
        variant="empty"
        title="Queue clear"
        description="No application is waiting for a decision."
      />
    );
  }
  return (
    <>
      {WAITING.map((state) => (
        <WaitingList key={state.status} state={state} />
      ))}
    </>
  );
}

function StatusQueue({ status }: { status: ApplicationStatus | '' }) {
  const applications = useApiPages({
    path: '/applications',
    request: { query: { limit: 50, ...(status ? { status } : {}) } },
  });
  return (
    <>
      <QueryBoundary
        query={applications}
        label="applications"
        isEmpty={(items) => items.length === 0}
        empty={{ title: 'No applications', description: 'No application has this status.' }}
        unavailableOffline={['approving, declining or overriding']}
      >
        {(items) => <ApplicationList items={items} />}
      </QueryBoundary>
      <LoadMore pages={applications} label="applications" />
    </>
  );
}

/** What the API's role view says about deciding (SPK-UX-005); the API still decides per record. */
function DecisionAuthority() {
  const permissions = usePermissions();
  const describe = (actionId: string): string => {
    const held = permissions.actionPermission(actionId);
    if (held === undefined) return 'not known yet';
    if (held === null) return 'not held by your roles';
    if (held.kind === 'conditional') return 'held for some records';
    return held.facilityIds === null ? 'held in every facility' : 'held in some facilities';
  };
  return (
    <p className="caption" aria-label="Decision permissions">
      Approving or declining needs enrollment.review_application (
      {describe('enrollment.review_application')}); overriding eligibility needs
      enrollment.override_eligibility ({describe('enrollment.override_eligibility')}).
    </p>
  );
}

export function RegistrationQueueScreen() {
  const [status, setStatus] = useState<Filter>(NEEDS_DECISION);
  return (
    <section aria-labelledby="queue-title">
      <h2 id="queue-title">Registration queue and approvals</h2>
      <SectionNav label="Registrations and waitlists" links={REGISTRATION_LINKS} />
      <p className="caption">
        Approval comes before any payment is captured, and it reserves no place unless an approved
        policy says so: pending {PENDING.approvals.ids.join(', ')} (owner: {PENDING.approvals.owner}
        ).
      </p>
      <DecisionAuthority />
      <SelectField
        label="Applications"
        value={status}
        placeholder="All statuses"
        onChange={(v) => setStatus(v as Filter)}
        options={[
          { value: NEEDS_DECISION, label: 'Waiting for a decision (submitted or awaiting review)' },
          ...STATUS_FILTERS.map((s) => ({ value: s, label: APPLICATION_STATUS[s].label })),
        ]}
      />
      {status === NEEDS_DECISION ? <DecisionQueue /> : <StatusQueue status={status} />}
    </section>
  );
}
