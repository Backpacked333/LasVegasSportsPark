/**
 * SCR-S-05 Publication review (SPK-SCHED-006, SPK-FIX-002, SPK-AT-008, §4.7 invariant 4,
 * `POST /v1/schedule-drafts/{id}/publish`). Shows the preflight (the draft's latest validation, or
 * "run it now"), exactly which events the publication changes with old and new details, and that one
 * schedule notice per changed event follows publication. Publishing sends the draft's
 * `expectedRevision` and an idempotency key per intent; a retry after no answer reuses it.
 *
 * Failures are shown honestly: the API publishes the whole group or nothing, so a stale draft
 * (STALE_REVISION), a physical conflict (RESOURCE_CONFLICT, listed per change) or an unmet fixture
 * obligation (VALIDATION_FAILED) is reported as "nothing was published". A successful publication
 * that left fixture obligations open is a partial publication and lists each remaining obligation
 * with owner and deadline (SPK-FIX-002). The publication's operation is read back
 * (`GET /v1/operations/{id}`); `recovery_required` is shown as needing attention (SPK-AT-023).
 */
import type { ApiError, Schema } from '@sportspark/api-client';
import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { useApp } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';
import { CommandError } from '../../features/schedule-facilities/CommandError';
import {
  blockingObligations,
  conflictIssues,
  conflictingEventIds,
} from '../../features/schedule-facilities/error-details';
import {
  useFacilityById,
  type FacilityContext,
} from '../../features/schedule-facilities/facility-scope';
import { resourceNames } from '../../features/schedule-facilities/inventory';
import { OPERATION_BADGE, draftBadge } from '../../features/schedule-facilities/labels';
import { formatInstant, localTimeOf } from '../../features/schedule-facilities/time';
import { describeChange, toInput, useTargetEvents } from './draft-changes';
import { DRAFTS_KEY } from './ScheduleDraftsScreen';
import { draftQueryKey } from './ScheduleDraftEditorScreen';

type ScheduleDraft = Schema<'ScheduleDraft'>;
type Publication = Schema<'Publication'>;

const PUBLISHABLE: ReadonlySet<ScheduleDraft['status']> = new Set([
  'editing',
  'validated',
  'failed',
]);

const STEPS = [
  'Recheck that you may publish for this facility',
  'Revalidate every change against current records',
  'Recheck all physical conflicts, including setup and cleanup buffers',
  'Verify fixture obligations',
  'Commit the approved revision',
  'Record the follow-up: one schedule notice per changed event',
  'Update customer and staff views',
];

function OperationStatus({ operationId }: { operationId: string }) {
  const operation = useApiQuery({
    path: '/operations/{id}',
    request: { path: { id: operationId } },
  });
  if (!operation.data) {
    return operation.error ? (
      <p className="caption">Operation status not available ({operation.error.code}).</p>
    ) : null;
  }
  const badge = OPERATION_BADGE[operation.data.status];
  return (
    <div>
      <StatusBadge tone={badge.tone} label={badge.label} />
      {operation.data.status === 'recovery_required' ? (
        <p>
          The revision was committed but its follow-up was not fully recorded. It is listed for the
          operations team to complete; do not publish the same changes again.
        </p>
      ) : null}
    </div>
  );
}

function PublicationResult({
  publication,
  facility,
}: {
  publication: Publication;
  facility: FacilityContext;
}) {
  const remaining = publication.summary.remainingObligations;
  return (
    <section
      aria-labelledby="publication-result"
      className="state"
      data-testid="publication-result"
    >
      <h4 id="publication-result">Published</h4>
      <StatusBadge
        tone={remaining.length > 0 ? 'warning' : 'success'}
        label={remaining.length > 0 ? 'Published with remaining obligations' : 'Published'}
      />
      <p>
        Committed {formatInstant(publication.committedAt, facility.timezone)}:{' '}
        {publication.eventIds.length} event{publication.eventIds.length === 1 ? '' : 's'} changed,{' '}
        {publication.noticeEventIds.length} schedule notice
        {publication.noticeEventIds.length === 1 ? '' : 's'} queued for the people involved.
      </p>
      {remaining.length > 0 ? (
        <>
          <p>
            This is a partial publication. These fixture obligations are still open and are recorded
            with their owner and deadline:
          </p>
          <ul className="list" aria-label="Remaining obligations">
            {remaining.map((o, i) => (
              <li key={`${o.code}-${i}`}>
                <div className="row-text">
                  <span className="row-title">{o.message}</span>
                  <span className="caption">
                    {o.code} · Owner: {o.owner} · Deadline:{' '}
                    {o.deadline ? formatInstant(o.deadline, facility.timezone) : 'none recorded'}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {publication.operationId ? <OperationStatus operationId={publication.operationId} /> : null}
      <Link to="/schedule/calendar">Open the calendar</Link>
    </section>
  );
}

function PublishFailure({
  error,
  facility,
  onRetry,
  onReload,
  draftId,
}: {
  error: ApiError;
  facility: FacilityContext;
  onRetry: () => void;
  onReload: () => void;
  draftId: string;
}) {
  const conflicts = conflictIssues(error);
  const conflicting = conflictingEventIds(error);
  const obligations = blockingObligations(error);
  // INVALID_TRANSITION is not "nothing published": the draft may have been published by an
  // earlier attempt whose answer was lost; the draft itself says which (checked by the caller).
  const nothingPublished =
    error.code === 'STALE_REVISION' ||
    error.code === 'RESOURCE_CONFLICT' ||
    error.code === 'VALIDATION_FAILED';
  return (
    <section aria-labelledby="publish-failure" role="alert" data-testid="publish-failure">
      <h4 id="publish-failure">
        {error.outcomeUnknown || error.isOffline
          ? 'Outcome unknown'
          : nothingPublished
            ? 'Nothing was published'
            : 'Publication did not complete'}
      </h4>
      {error.code === 'INVALID_TRANSITION' ? (
        <p>The draft is no longer publishable in its current state. Reload to see its state.</p>
      ) : null}
      {error.code === 'STALE_REVISION' ? (
        <p>
          The draft, or an event it changes, was edited after this review was loaded. Reload, check
          the changes again, then publish.
        </p>
      ) : null}
      {conflicts.length > 0 ? (
        <>
          <p>
            The draft conflicts with current records
            {conflicting.length > 0
              ? ` (${conflicting.length} existing event${conflicting.length === 1 ? '' : 's'} involved)`
              : ''}
            . Resolve these in the editor:
          </p>
          <ul className="list" aria-label="Conflicts">
            {conflicts.map((c, i) => (
              <li key={`${c.code}-${i}`}>
                {c.changeSequence ? `Change ${c.changeSequence}: ` : ''}
                {c.message} <span className="caption">({c.code})</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {obligations.length > 0 ? (
        <>
          <p>Fixture obligations that must be met before this group can publish:</p>
          <ul className="list" aria-label="Unmet fixture obligations">
            {obligations.map((o, i) => (
              <li key={`${o.code}-${i}`}>
                {o.message}{' '}
                <span className="caption">
                  ({o.code}
                  {o.owner ? `, owner ${o.owner}` : ''}
                  {o.deadline ? `, deadline ${formatInstant(o.deadline, facility.timezone)}` : ''})
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <CommandError
        error={error}
        onRetry={onRetry}
        onReload={error.isStale ? onReload : undefined}
        action="Publishing"
      />
      <Link to={`/schedule/drafts/${draftId}`}>Back to the editor</Link>
    </section>
  );
}

/**
 * The draft itself says it was published (for example by an attempt whose answer was lost and
 * that the refetched draft now shows): never shown as a failure (SPK-SCHED-005, §4.9).
 */
function DraftPublished({ draft, facility }: { draft: ScheduleDraft; facility: FacilityContext }) {
  return (
    <section aria-labelledby="draft-published" className="state" data-testid="publication-result">
      <h4 id="draft-published">Published</h4>
      <StatusBadge tone="success" label="Published" />
      <p>
        This draft was published
        {draft.publishedAt ? ` ${formatInstant(draft.publishedAt, facility.timezone)}` : ''}. Its{' '}
        {draft.changes.length} change{draft.changes.length === 1 ? '' : 's'} are in the calendar; do
        not publish them again.
      </p>
      <Link to="/schedule/calendar">Open the calendar</Link>
    </section>
  );
}

function Review({ draft, facility }: { draft: ScheduleDraft; facility: FacilityContext }) {
  const { online } = useApp();
  const queryClient = useQueryClient();
  const tz = facility.timezone;
  const [reason, setReason] = useState('');
  const resources = useApiQuery({
    path: '/resources',
    request: { query: { facilityId: draft.facilityId } },
  });
  const names = resourceNames(resources.data ?? []);
  const targets = useTargetEvents(
    draft.changes.flatMap((c) => (c.targetEventId ? [c.targetEventId] : [])),
  );
  const refreshDraft = () => queryClient.invalidateQueries({ queryKey: draftQueryKey(draft.id) });
  const validate = useApiCommand('post', '/schedule-drafts/{id}/validate', {
    invalidate: [DRAFTS_KEY],
  });
  const publish = useApiCommand('post', '/schedule-drafts/{id}/publish', {
    invalidate: [DRAFTS_KEY, ['api', '/events'], ['api', '/events/{id}']],
  });

  const runValidation = () =>
    void validate
      .submit({ path: { id: draft.id }, body: { expectedRevision: draft.revision } })
      .then(() => refreshDraft())
      .catch(() => undefined);
  // The body of the attempt in flight: "Try again" resends exactly it (same fingerprint, so the
  // same Idempotency-Key), even if the draft refetched with a newer revision meanwhile (§4.9).
  const sent = useRef<{ expectedRevision: number; reason?: string } | null>(null);
  const sendPublish = (body: { expectedRevision: number; reason?: string }) =>
    void publish
      .submit({ path: { id: draft.id }, body })
      .then(() => {
        sent.current = null;
        return refreshDraft();
      })
      .catch((error: ApiError) => {
        // The API records a failed publication on the draft; show its current state.
        if (!error.outcomeUnknown && !error.isOffline) void refreshDraft();
      });
  const runPublish = () => {
    const body = {
      expectedRevision: draft.revision,
      ...(reason.trim() ? { reason: reason.trim() } : {}),
    };
    sent.current = body;
    sendPublish(body);
  };
  const retryPublish = () => {
    if (sent.current) sendPublish(sent.current);
    else runPublish();
  };
  const reload = () => {
    sent.current = null;
    publish.reset();
    void refreshDraft();
  };

  if (publish.data) return <PublicationResult publication={publish.data} facility={facility} />;
  if (draft.status === 'published' || draft.publicationGroupId !== null) {
    return <DraftPublished draft={draft} facility={facility} />;
  }

  const validation = draft.validationResults;
  const current =
    validation !== null && draft.validatedAt !== null && draft.validatedAt >= draft.lastSavedAt;
  const errors = validation?.issues.filter((i) => i.severity === 'error') ?? [];
  const warnings = validation?.issues.filter((i) => i.severity === 'warning') ?? [];
  const canPublish = PUBLISHABLE.has(draft.status) && draft.changes.length > 0;
  const badge = draftBadge(draft.status, localTimeOf(draft.lastSavedAt, tz));

  return (
    <div>
      <p>
        <strong>{draft.name}</strong> <StatusBadge tone={badge.tone} label={badge.label} />
      </p>
      <section aria-labelledby="preflight-title">
        <h4 id="preflight-title">Preflight</h4>
        {validation ? (
          <p role="status">
            {validation.ok ? 'Passed' : 'Failed'} {formatInstant(validation.validatedAt, tz)}:{' '}
            {errors.length} error{errors.length === 1 ? '' : 's'}, {warnings.length} warning
            {warnings.length === 1 ? '' : 's'}.
            {current ? '' : ' The draft was saved after this check; run it again.'}
          </p>
        ) : (
          <p>The draft has not been validated since it was last saved.</p>
        )}
        {[...errors, ...warnings].length > 0 ? (
          <ul className="list" aria-label="Preflight results">
            {[...errors, ...warnings].map((issue, i) => (
              <li key={`${issue.code}-${i}`}>
                <StatusBadge
                  tone={issue.severity === 'error' ? 'danger' : 'warning'}
                  label={issue.severity === 'error' ? 'Error' : 'Warning'}
                />{' '}
                {issue.changeSequence ? `Change ${issue.changeSequence}: ` : ''}
                {issue.message} <span className="caption">({issue.code})</span>
              </li>
            ))}
          </ul>
        ) : null}
        <Button
          variant="secondary"
          busy={validate.isProcessing}
          disabled={!online || !canPublish}
          onClick={runValidation}
        >
          Run preflight now
        </Button>
        {validate.error ? (
          <CommandError
            error={validate.error}
            onRetry={runValidation}
            onReload={reload}
            action="Validating"
          />
        ) : null}
      </section>

      <section aria-labelledby="publish-changes-title">
        <h4 id="publish-changes-title">What will change ({draft.changes.length})</h4>
        {draft.changes.length === 0 ? (
          <StateView
            variant="empty"
            title="Nothing to publish"
            description="This draft has no changes."
          />
        ) : (
          <ol className="list" aria-label="Changes to publish">
            {draft.changes.map((c) => {
              const text = describeChange(
                toInput(c),
                c.targetEventId ? targets.get(c.targetEventId)?.event : undefined,
                names,
                tz,
              );
              return (
                <li key={c.sequence}>
                  <div className="row-text">
                    <span className="row-title">
                      {c.sequence}. {text.title}
                    </span>
                    <span className="caption">{text.detail}</span>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
        <p>
          After publication, one schedule notice per changed event ({draft.changes.length}) is
          queued with the old and new details. Who receives it, and on which channels, follows the
          communication policy.
        </p>
        <StateView
          variant="pending-decision"
          subject="The communication policy and channels for schedule notices"
          decisions={['DEC-012', 'DEC-062']}
          owner="Operator/privacy owner"
        />
        <p className="caption">
          Fixture obligations are checked during publication: a blocking one stops the whole
          publication; others are recorded with an owner and deadline.
        </p>
      </section>

      <section aria-labelledby="publish-title">
        <h4 id="publish-title">Publish</h4>
        <ol className="caption" aria-label="Publication steps">
          {STEPS.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ol>
        <p className="caption">
          All changes publish together or none do; a stale or conflicting draft publishes nothing.
        </p>
        <label htmlFor="publish-reason">Note for the audit record (optional)</label>
        <input
          id="publish-reason"
          value={reason}
          maxLength={2000}
          onChange={(e) => setReason(e.target.value)}
        />
        {publish.isProcessing ? (
          <p role="status" aria-busy="true">
            Publishing… the operation is running.
          </p>
        ) : null}
        <Button busy={publish.isProcessing} disabled={!online || !canPublish} onClick={runPublish}>
          Publish {draft.changes.length} change{draft.changes.length === 1 ? '' : 's'}
        </Button>
        {!online ? <p className="caption">Publishing needs a connection.</p> : null}
        {!PUBLISHABLE.has(draft.status) ? (
          <p className="caption">A {draft.status} draft cannot be published.</p>
        ) : null}
        {publish.error ? (
          <PublishFailure
            error={publish.error}
            facility={facility}
            onRetry={retryPublish}
            onReload={reload}
            draftId={draft.id}
          />
        ) : null}
      </section>
    </div>
  );
}

export function PublicationReviewScreen() {
  const { draftId = '' } = useParams();
  const draft = useApiQuery({ path: '/schedule-drafts/{id}', request: { path: { id: draftId } } });
  const facility = useFacilityById(draft.data?.facilityId);
  return (
    <section aria-labelledby="publication-title">
      <h3 id="publication-title">Publication review</h3>
      <Link to={`/schedule/drafts/${draftId}`}>Back to the draft</Link>
      <QueryBoundary
        query={draft}
        label="the draft"
        empty={{ title: '', description: '' }}
        unavailableOffline={['publishing']}
      >
        {(data) =>
          facility ? (
            <Review draft={data} facility={facility} />
          ) : (
            <StateView variant="loading" label="the facility" />
          )
        }
      </QueryBoundary>
    </section>
  );
}
