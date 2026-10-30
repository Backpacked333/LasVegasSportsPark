/**
 * SCR-S-04 Schedule draft editor (SPK-SCHED-004, SPK-SCHED-005, SPK-SCHED-007, SPK-SCHED-008,
 * SPK-UX-009; DEC-050 pending). An autosaved draft showing its base revisions, proposed changes,
 * validation results per change, author, last save and publication status. Drafts send no customer
 * notices.
 *
 * - Autosave: every edit saves the whole change list with `PATCH /v1/schedule-drafts/{id}` and the
 *   draft's `expectedRevision`, one save at a time. A retry of the same save reuses its idempotency
 *   key. Offline, edits stay on this page and are saved when the connection returns ("draft edits
 *   kept locally until save"); nothing is presented as saved before the API confirms it.
 * - Concurrent editor: STALE_REVISION keeps the user's edits and offers to load the latest version
 *   or to save these edits on top of it (an explicit choice, never silent).
 * - Base revisions: the API keeps the base revision a change captured when it entered the draft, on
 *   every save (SPK-SCHED-005), so autosave never rebases. An event that changed after the draft
 *   captured it is flagged on its change ("rebase required"), and publication refuses the draft
 *   until it is rebased. "Rebase onto the current event" does what the API documents: one save
 *   without that event's changes, then one with them again, which captures the event's current
 *   revision. A rebase that captured a revision newer than the one the user reviewed is flagged
 *   again, so a draft is never rebased past what the user saw.
 * - Validation: `POST /v1/schedule-drafts/{id}/validate` lists conflicts per change (conflict unit
 *   overlap, team or official overlap, rest, closure, operating hours, format).
 * - Read-only when the draft is published, discarded or publishing, or when the viewer's roles do
 *   not include scheduling.manage_drafts at its facility (`GET /v1/me/permissions`; shown as not
 *   available, naming the permission). "Review and publish" needs scheduling.publish_schedule.
 */
import type { ApiError, ApiResponse, Schema } from '@sportspark/api-client';
import { apiQueryKey } from '@sportspark/api-client';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
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
  useFacilityById,
  type FacilityContext,
} from '../../features/schedule-facilities/facility-scope';
import { resourceNames } from '../../features/schedule-facilities/inventory';
import { NotAvailableToYou, useActionAllowed } from '../../features/schedule-facilities/permission';
import { draftBadge } from '../../features/schedule-facilities/labels';
import { formatInstant, localTimeOf } from '../../features/schedule-facilities/time';
import { ExistingEventForm, NewEventForm } from './DraftChangeForms';
import {
  CHANGE_KIND_LABEL,
  describeChange,
  toInput,
  useTargetEvents,
  type DraftChangeInput,
} from './draft-changes';
import { DRAFTS_KEY } from './ScheduleDraftsScreen';

type ScheduleDraft = Schema<'ScheduleDraft'>;
type ValidationIssue = Schema<'ValidationIssue'>;

const READ_ONLY: ReadonlySet<ScheduleDraft['status']> = new Set([
  'published',
  'discarded',
  'publishing',
]);

export function draftQueryKey(id: string) {
  return apiQueryKey('/schedule-drafts/{id}', { path: { id } });
}

/** Automatic retries while the service is unreachable but the device is online. */
const AUTOSAVE_BACKOFF_MS = [5_000, 15_000, 60_000] as const;

type SaveState =
  | { kind: 'saved' }
  | { kind: 'saving' }
  | { kind: 'offline' }
  | { kind: 'stale' }
  | { kind: 'failed'; error: ApiError };

interface Snapshot {
  name: string;
  changes: DraftChangeInput[];
}

/** Serial autosave with the draft revision; see the screen comment. */
function useDraftAutosave(draft: ScheduleDraft) {
  const { online, services } = useApp();
  const queryClient = useQueryClient();
  const save = useApiCommand('patch', '/schedule-drafts/{id}', { invalidate: [DRAFTS_KEY] });
  const submitRef = useRef(save.submit);
  const revision = useRef(draft.revision);
  const queued = useRef<Snapshot | null>(null);
  const inFlight = useRef(false);
  const onlineRef = useRef(online);
  // Targets being rebased: the next save leaves their changes out, the one after adds them again.
  const rebasing = useRef<ReadonlySet<string>>(new Set());
  const [state, setState] = useState<SaveState>({ kind: 'saved' });
  const [pending, setPending] = useState(false);

  useEffect(() => {
    submitRef.current = save.submit;
  }, [save.submit]);

  const adopt = useCallback(
    (next: ScheduleDraft) => {
      revision.current = next.revision;
      queryClient.setQueryData<ApiResponse<ScheduleDraft>>(draftQueryKey(next.id), (old) =>
        old
          ? { ...old, data: next, receivedAt: services.now() }
          : {
              data: next,
              status: 200,
              correlationId: null,
              replayed: false,
              receivedAt: services.now(),
            },
      );
    },
    [queryClient, services],
  );

  const flush = useCallback(async (): Promise<void> => {
    if (inFlight.current || !queued.current) return;
    if (!onlineRef.current) {
      setState({ kind: 'offline' });
      return;
    }
    const snapshot = queued.current;
    const dropping = rebasing.current;
    const without = snapshot.changes.filter(
      (c) => !c.targetEventId || !dropping.has(c.targetEventId),
    );
    // First leg of a rebase: save without the rebased targets; the snapshot stays queued.
    const firstLeg = dropping.size > 0 && without.length < snapshot.changes.length;
    queued.current = firstLeg ? snapshot : null;
    inFlight.current = true;
    setState({ kind: 'saving' });
    try {
      const saved = await submitRef.current({
        path: { id: draft.id },
        body: {
          expectedRevision: revision.current,
          name: snapshot.name,
          changes: firstLeg ? without : snapshot.changes,
        },
      });
      adopt(saved);
      inFlight.current = false;
      if (dropping.size > 0 && rebasing.current === dropping) rebasing.current = new Set();
      if (queued.current) {
        void flush();
      } else {
        setPending(false);
        setState({ kind: 'saved' });
      }
    } catch (e) {
      inFlight.current = false;
      queued.current = queued.current ?? snapshot;
      const error = e as ApiError;
      if (error.code === 'STALE_REVISION') setState({ kind: 'stale' });
      else if (error.isOffline && error.kind === 'network') setState({ kind: 'offline' });
      else setState({ kind: 'failed', error });
    }
  }, [adopt, draft.id]);

  useEffect(() => {
    onlineRef.current = online;
    if (online && queued.current) void flush();
  }, [online, flush]);

  // The device reports a connection but the service could not be reached (DNS, proxy, API down):
  // retry the same snapshot with a bounded backoff, as the same intent (same key, §4.9).
  const unreachableAttempts = useRef(0);
  useEffect(() => {
    if (state.kind !== 'offline' || !online) {
      if (state.kind === 'saved') unreachableAttempts.current = 0;
      return;
    }
    const delay = AUTOSAVE_BACKOFF_MS[unreachableAttempts.current];
    if (delay === undefined) return;
    const timer = setTimeout(() => {
      unreachableAttempts.current += 1;
      void flush();
    }, delay);
    return () => clearTimeout(timer);
  }, [state, online, flush]);

  const schedule = useCallback(
    (snapshot: Snapshot) => {
      queued.current = snapshot;
      setPending(true);
      void flush();
    },
    [flush],
  );

  /** After STALE_REVISION: continue on the latest revision with these edits. */
  const saveOnLatest = useCallback(
    (latest: ScheduleDraft) => {
      revision.current = latest.revision;
      void flush();
    },
    [flush],
  );

  /**
   * Rebase the changes of one target event: save without them, then with them again, so the API
   * captures the event's current revision (SPK-SCHED-005).
   */
  const rebase = useCallback(
    (targetEventId: string, snapshot: Snapshot) => {
      rebasing.current = new Set([...rebasing.current, targetEventId]);
      schedule(snapshot);
    },
    [schedule],
  );

  /** After STALE_REVISION: drop unsaved edits. */
  const discardPending = useCallback(
    (latest: ScheduleDraft) => {
      queued.current = null;
      rebasing.current = new Set();
      setPending(false);
      adopt(latest);
      setState({ kind: 'saved' });
    },
    [adopt],
  );

  return {
    state,
    pending,
    schedule,
    retry: () => void flush(),
    adopt,
    revision: () => revision.current,
    saveOnLatest,
    discardPending,
    rebase,
  };
}

function IssueList({ issues, label }: { issues: readonly ValidationIssue[]; label: string }) {
  if (issues.length === 0) return null;
  return (
    <ul className="issue-list" aria-label={label}>
      {issues.map((issue, i) => (
        <li key={`${issue.code}-${i}`}>
          <StatusBadge
            tone={issue.severity === 'error' ? 'danger' : 'warning'}
            label={issue.severity === 'error' ? 'Error' : 'Warning'}
          />{' '}
          {issue.message} <span className="caption">({issue.code}</span>
          {issue.detail?.conflictingEventIds?.length ? (
            <span className="caption">
              , conflicts with {issue.detail.conflictingEventIds.length} event
              {issue.detail.conflictingEventIds.length === 1 ? '' : 's'}
            </span>
          ) : null}
          <span className="caption">)</span>
        </li>
      ))}
    </ul>
  );
}

function SaveStatus({
  state,
  pending,
  online,
  draft,
  tz,
  onRetry,
  onLoadLatest,
  onKeepMine,
}: {
  state: SaveState;
  pending: boolean;
  online: boolean;
  draft: ScheduleDraft;
  tz: string;
  onRetry: () => void;
  onLoadLatest: () => void;
  onKeepMine: () => void;
}) {
  switch (state.kind) {
    case 'saving':
      return (
        <p role="status" aria-busy="true">
          Saving…
        </p>
      );
    case 'saved':
      return (
        <p role="status">
          {pending
            ? 'Saving…'
            : `All changes saved. Last saved ${formatInstant(draft.lastSavedAt, tz)}.`}
        </p>
      );
    case 'offline':
      return online ? (
        <div role="status" className="banner">
          <StatusBadge tone="warning" label="Not saved: service not reachable" />
          <span>
            The service could not be reached. Your edits are kept on this page and saving is retried
            automatically; do not close the page.
          </span>
          <Button variant="secondary" onClick={onRetry}>
            Try again
          </Button>
        </div>
      ) : (
        <div role="status" className="banner">
          <StatusBadge tone="warning" label="Not saved: offline" />
          <span>
            Your edits are kept on this page and will be saved when the connection returns. Do not
            close the page.
          </span>
        </div>
      );
    case 'stale':
      return (
        <div role="alert" className="banner" data-testid="draft-stale">
          <StatusBadge tone="danger" label="Not saved: draft changed elsewhere" />
          <span>
            Someone (or another window) saved this draft after you opened it. Your edits are kept on
            this page.
          </span>
          <Button variant="secondary" onClick={onLoadLatest}>
            Load the latest version (drop my unsaved edits)
          </Button>
          <Button onClick={onKeepMine}>Save my edits on the latest version</Button>
        </div>
      );
    case 'failed':
      return (
        <div role="alert">
          <p className="error-text">Autosave failed. Your edits are kept on this page.</p>
          <CommandError error={state.error} onRetry={onRetry} action="Saving the draft" />
        </div>
      );
  }
}

function DraftEditor({
  draft,
  facility,
  refetch,
}: {
  draft: ScheduleDraft;
  facility: FacilityContext;
  refetch: () => Promise<ScheduleDraft | undefined>;
}) {
  const { online } = useApp();
  const tz = facility.timezone;
  // SPK-UX-008 permission restriction: the role view (GET /v1/me/permissions) at the draft's facility.
  const canEdit = useActionAllowed('scheduling.manage_drafts', draft.facilityId);
  const canPublish = useActionAllowed('scheduling.publish_schedule', draft.facilityId);
  const closedDraft = READ_ONLY.has(draft.status);
  const readOnly = closedDraft || !canEdit;
  const [working, setWorking] = useState<DraftChangeInput[]>(() => draft.changes.map(toInput));
  const [name, setName] = useState(draft.name);
  // The revision of each target event the user had in front of them when they pressed Rebase.
  const [reviewed, setReviewed] = useState<ReadonlyMap<string, number>>(new Map());
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const resources = useApiQuery({
    path: '/resources',
    request: { query: { facilityId: draft.facilityId } },
  });
  const names = resourceNames(resources.data ?? []);
  const targets = useTargetEvents(
    [...working, ...draft.changes].flatMap((c) => (c.targetEventId ? [c.targetEventId] : [])),
  );

  // Base revisions no longer current: from the events as loaded and from the last validation. A
  // rebase that captured a newer revision than the one the user reviewed needs another review, so a
  // draft is never rebased past what the user saw (SPK-SCHED-005).
  const staleTargets = new Set<string>();
  for (const c of draft.changes) {
    if (!c.targetEventId || c.baseEventRevision === null) continue;
    const current = targets.get(c.targetEventId)?.event;
    const seen = reviewed.get(c.targetEventId);
    if (
      (current && current.revision !== c.baseEventRevision) ||
      (seen !== undefined && c.baseEventRevision > seen)
    ) {
      staleTargets.add(c.targetEventId);
    }
  }
  for (const issue of draft.validationResults?.issues ?? []) {
    if (issue.code === 'stale_revision' && issue.eventId) staleTargets.add(issue.eventId);
  }
  // Publication refuses a stale base; a change removed from the working copy no longer counts.
  const needsRebase = [...staleTargets].filter((id) => working.some((c) => c.targetEventId === id));
  const autosave = useDraftAutosave(draft);
  const queryClient = useQueryClient();
  const rebase = (targetEventId: string) => {
    const shown = targets.get(targetEventId)?.event?.revision;
    if (shown === undefined) return;
    setReviewed((prev) => new Map(prev).set(targetEventId, shown));
    autosave.rebase(targetEventId, { name: name.trim() || draft.name, changes: working });
    void queryClient.invalidateQueries({
      queryKey: apiQueryKey('/events/{id}', { path: { id: targetEventId } }),
    });
  };

  const validate = useApiCommand('post', '/schedule-drafts/{id}/validate', {
    invalidate: [DRAFTS_KEY],
  });
  const discard = useApiCommand('post', '/schedule-drafts/{id}/discard', {
    invalidate: [DRAFTS_KEY],
  });
  const settled = autosave.state.kind === 'saved' && !autosave.pending;
  // Edits stay possible offline (kept on this page, saved on reconnect); commands need a connection.
  const editable = !readOnly;

  const commit = (next: DraftChangeInput[], nextName = name) => {
    setWorking(next);
    autosave.schedule({ name: nextName.trim() || draft.name, changes: next });
  };

  const runValidation = () =>
    void validate
      .submit({ path: { id: draft.id }, body: { expectedRevision: autosave.revision() } })
      .then(autosave.adopt)
      .catch(() => undefined);

  const runDiscard = () =>
    void discard
      .submit({ path: { id: draft.id }, body: { expectedRevision: autosave.revision() } })
      .then((d) => {
        autosave.adopt(d);
        setConfirmDiscard(false);
      })
      .catch(() => undefined);

  const loadLatest = () =>
    void refetch().then((latest) => {
      if (!latest) return;
      setWorking(latest.changes.map(toInput));
      setName(latest.name);
      autosave.discardPending(latest);
    });
  const keepMine = () =>
    void refetch().then((latest) => {
      if (latest) autosave.saveOnLatest(latest);
    });

  const validation = draft.validationResults;
  const savedMatchesWorking = settled && working.length === draft.changes.length;
  const issuesFor = (sequence: number) =>
    savedMatchesWorking
      ? (validation?.issues ?? []).filter((i) => i.changeSequence === sequence)
      : [];
  const general = (validation?.issues ?? []).filter((i) => i.changeSequence === undefined);
  const errors = (validation?.issues ?? []).filter((i) => i.severity === 'error').length;
  const warnings = (validation?.issues ?? []).length - errors;
  const badge = draftBadge(draft.status, localTimeOf(draft.lastSavedAt, tz));

  return (
    <div className="draft-editor">
      <div className="row-text">
        <label htmlFor="draft-name">Draft name</label>
        <input
          id="draft-name"
          value={name}
          maxLength={200}
          disabled={!editable}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => {
            if (name.trim() && name.trim() !== draft.name) commit(working, name);
          }}
        />
        <StatusBadge tone={badge.tone} label={badge.label} />
        <dl className="facts">
          <dt>Facility</dt>
          <dd>{facility.name}</dd>
          <dt>Author</dt>
          <dd>{draft.author.actorLabel || 'not recorded'}</dd>
          <dt>Base captured</dt>
          <dd>{formatInstant(draft.baseRevision.capturedAt, tz)}</dd>
          <dt>Last saved</dt>
          <dd>{formatInstant(draft.lastSavedAt, tz)}</dd>
          <dt>Publication</dt>
          <dd>
            {draft.publishedAt
              ? `Published ${formatInstant(draft.publishedAt, tz)}`
              : 'Not published. Customers see nothing from this draft.'}
          </dd>
        </dl>
      </div>
      {closedDraft ? (
        <StateView
          variant="unavailable"
          title={`This draft is ${draft.status}`}
          description="It can no longer be edited. Open a new draft for further changes."
        />
      ) : readOnly ? (
        <NotAvailableToYou what="Editing schedule drafts" action="scheduling.manage_drafts" />
      ) : (
        <SaveStatus
          state={autosave.state}
          pending={autosave.pending}
          online={online}
          draft={draft}
          tz={tz}
          onRetry={autosave.retry}
          onLoadLatest={loadLatest}
          onKeepMine={keepMine}
        />
      )}
      {!online && !readOnly ? (
        <p className="caption">
          Offline: you can keep editing; changes are saved when the connection returns. Validating,
          publishing and discarding need a connection.
        </p>
      ) : null}

      <section aria-labelledby="draft-changes-title">
        <h4 id="draft-changes-title">Proposed changes ({working.length})</h4>
        {working.length === 0 ? (
          <StateView
            variant="empty"
            title="No changes yet"
            description="Add a new event or change a published one below. Nothing is published until you publish the draft."
          />
        ) : (
          <ol className="list" aria-label="Proposed changes">
            {working.map((change, index) => {
              const target = change.targetEventId ? targets.get(change.targetEventId) : undefined;
              const saved = draft.changes[index];
              const text = describeChange(change, target?.event, names, tz);
              const stale =
                change.targetEventId !== undefined && staleTargets.has(change.targetEventId);
              return (
                <li
                  key={`${index}-${change.kind}-${change.targetEventId ?? 'new'}`}
                  data-testid={`draft-change-${index + 1}`}
                >
                  <div className="row-text">
                    <span className="row-title">
                      {index + 1}. {text.title}
                    </span>
                    <span className="caption">{text.detail}</span>
                    {change.targetEventId ? (
                      <span className="caption">
                        Base revision{' '}
                        {saved?.targetEventId === change.targetEventId &&
                        saved.baseEventRevision !== null
                          ? saved.baseEventRevision
                          : 'captured on save'}
                        {target?.event ? `; event now at revision ${target.event.revision}` : ''}
                        {target?.error ? `; event not available (${target.error.code})` : ''}
                      </span>
                    ) : null}
                    {stale && change.targetEventId ? (
                      <span className="banner">
                        <StatusBadge tone="warning" label="Rebase required" />
                        The event changed since this draft captured it, so publishing is refused
                        until the change is rebased. Check its current details above.
                        {editable && target?.event ? (
                          <Button
                            variant="secondary"
                            onClick={() => rebase(change.targetEventId as string)}
                          >
                            Rebase onto the current event
                          </Button>
                        ) : null}
                      </span>
                    ) : null}
                    <IssueList
                      issues={issuesFor(index + 1)}
                      label={`Validation results for change ${index + 1}`}
                    />
                  </div>
                  <span className="caption">{CHANGE_KIND_LABEL[change.kind]}</span>
                  {editable ? (
                    <Button
                      variant="secondary"
                      aria-label={`Remove change ${index + 1}: ${text.title}`}
                      onClick={() => commit(working.filter((_, j) => j !== index))}
                    >
                      Remove
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ol>
        )}
      </section>

      <section aria-labelledby="draft-validation-title">
        <h4 id="draft-validation-title">Validation</h4>
        {validation ? (
          <p role="status">
            {validation.ok ? 'Passed' : 'Failed'}: validated{' '}
            {formatInstant(validation.validatedAt, tz)} with {errors} error{errors === 1 ? '' : 's'}{' '}
            and {warnings} warning{warnings === 1 ? '' : 's'}.
          </p>
        ) : (
          <p>Not validated since the last save.</p>
        )}
        <IssueList issues={general} label="Validation results for the whole draft" />
        <p className="caption">
          Checks: shared space including setup and cleanup buffers, closures, operating hours,
          compatible formats, team, coach and official overlap, required rest. Staffing constraints
          are not part of this check.
        </p>
        <StateView
          variant="pending-decision"
          subject="Checking participant conflicts (SPK-SCHED-004)"
          decisions={['DEC-050']}
          owner="Operations (scheduling acceptance); Program manager"
        />
        {!readOnly ? (
          <Button
            variant="secondary"
            disabled={!editable || !online || !settled || working.length === 0}
            busy={validate.isProcessing}
            onClick={runValidation}
          >
            Validate
          </Button>
        ) : null}
        {validate.error ? (
          <CommandError
            error={validate.error}
            onRetry={runValidation}
            onReload={() => void refetch()}
            action="Validating the draft"
          />
        ) : null}
      </section>

      {!readOnly ? (
        <>
          {!canPublish ? (
            <NotAvailableToYou what="Publishing schedules" action="scheduling.publish_schedule" />
          ) : settled && online && needsRebase.length === 0 ? (
            <Link to={`/schedule/drafts/${draft.id}/publish`} className="button button-primary">
              Review and publish
            </Link>
          ) : (
            <Button disabled>
              Review and publish (
              {!online
                ? 'needs a connection'
                : needsRebase.length > 0
                  ? 'after the flagged changes are rebased'
                  : 'after the draft is saved'}
              )
            </Button>
          )}
          <section aria-labelledby="draft-add-title">
            <h4 id="draft-add-title">Add changes</h4>
            <NewEventForm
              facility={facility}
              resources={resources.data ?? []}
              disabled={!editable}
              onAdd={(added) => commit([...working, ...added])}
            />
            <ExistingEventForm
              facility={facility}
              resources={resources.data ?? []}
              disabled={!editable}
              onAdd={(added) => commit([...working, ...added])}
            />
          </section>
          <section aria-labelledby="draft-discard-title">
            <h4 id="draft-discard-title">Discard</h4>
            {confirmDiscard ? (
              <>
                <p>
                  Discarding keeps the draft for history; none of its changes will be published.
                </p>
                <Button busy={discard.isProcessing} disabled={!online} onClick={runDiscard}>
                  Confirm discard
                </Button>
                <Button variant="secondary" onClick={() => setConfirmDiscard(false)}>
                  Keep the draft
                </Button>
              </>
            ) : (
              <Button
                variant="secondary"
                disabled={!editable || !online}
                onClick={() => setConfirmDiscard(true)}
              >
                Discard draft
              </Button>
            )}
            {discard.error ? (
              <CommandError
                error={discard.error}
                onRetry={runDiscard}
                onReload={() => void refetch()}
                action="Discarding the draft"
              />
            ) : null}
          </section>
        </>
      ) : null}
    </div>
  );
}

export function ScheduleDraftEditorScreen() {
  const { draftId = '' } = useParams();
  const draft = useApiQuery({
    path: '/schedule-drafts/{id}',
    request: { path: { id: draftId } },
    staleTime: Infinity,
  });
  const facility = useFacilityById(draft.data?.facilityId);
  return (
    <section aria-labelledby="draft-editor-title">
      <h3 id="draft-editor-title">Schedule draft</h3>
      <Link to="/schedule/drafts">All drafts</Link>
      <QueryBoundary
        query={draft}
        label="the draft"
        empty={{ title: '', description: '' }}
        unavailableOffline={['saving, validating or publishing the draft']}
      >
        {(data) =>
          facility ? (
            <DraftEditor
              key={data.id}
              draft={data}
              facility={facility}
              refetch={async () => (await draft.refetch()).data?.data}
            />
          ) : (
            <StateView variant="loading" label="the facility" />
          )
        }
      </QueryBoundary>
    </section>
  );
}
