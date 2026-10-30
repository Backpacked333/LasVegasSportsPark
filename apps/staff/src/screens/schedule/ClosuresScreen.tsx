/**
 * SCR-S-06 entry: the facility's closures and "New closure" (SPK-SCHED-009, SPK-FAC-003).
 *
 * - Preview first (`GET /v1/closure-impact`, SCH-01): the impact of closing the chosen area for the
 *   interval is computed without creating anything, with the affected events, customers,
 *   financial obligations and unsent messages. A change to the area or times after the preview
 *   asks for a new preview before anything is created.
 * - Create (`POST /v1/closures`, one idempotency key per intent) records the closure as `pending`
 *   with its impact and closes nothing yet; the detail screen applies or withdraws it.
 * - Closures from maintenance restrictions are listed with their source; their return to service is
 *   a release, and their withdrawal a restriction withdrawal, on SCR-S-42.
 */
import type { ApiError, Schema } from '@sportspark/api-client';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { useApp } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';
import { CommandError } from '../../features/schedule-facilities/CommandError';
import {
  FacilityGate,
  ZoneCaption,
  type FacilityContext,
} from '../../features/schedule-facilities/facility-scope';
import { resourceNames } from '../../features/schedule-facilities/inventory';
import { ActionGate } from '../../features/schedule-facilities/permission';
import { CLOSURE_BADGE } from '../../features/schedule-facilities/labels';
import {
  LocalDateTimeField,
  emptyLocal,
  toInstant,
  type LocalDateTime,
} from '../../features/schedule-facilities/LocalDateTimeField';
import { ResourceChecklist } from '../../features/schedule-facilities/ResourceChecklist';
import { formatInstant, formatRange } from '../../features/schedule-facilities/time';
import { AffectedEventList, ImpactParties, ImpactSummary } from './ClosureImpactView';

type ClosureStatus = Schema<'Closure'>['status'];
export const CLOSURES_KEY = ['api', '/closures'] as const;

const SOURCE_LABEL: Record<Schema<'Closure'>['source'], string> = {
  manual: 'Closure',
  holiday: 'Holiday closure',
  maintenance: 'Maintenance restriction',
};

interface PreviewQuery {
  facilityId: string;
  resourceId?: string;
  start: string;
  end: string;
}

/** A failed preview read: not available, the API's field messages, or the code with a retry. */
function PreviewError({ error, onRetry }: { error: ApiError; onRetry: () => void }) {
  if (error.isOffline) {
    return (
      <section className="state" aria-live="polite">
        <StatusBadge tone="warning" label="Preview not loaded" />
        <p>No answer arrived for the impact preview. Nothing was created.</p>
        <Button onClick={onRetry}>Try again</Button>
      </section>
    );
  }
  return <CommandError error={error} onRetry={onRetry} action="Previewing a closure" />;
}

function NewClosureForm({ facility }: { facility: FacilityContext }) {
  const navigate = useNavigate();
  const { online } = useApp();
  const tz = facility.timezone;
  const resources = useApiQuery({
    path: '/resources',
    request: { query: { facilityId: facility.id } },
  });
  const [scope, setScope] = useState<'' | 'facility' | 'space'>('');
  const [resourceId, setResourceId] = useState<string[]>([]);
  const [start, setStart] = useState<LocalDateTime>(emptyLocal());
  const [end, setEnd] = useState<LocalDateTime>(emptyLocal());
  const [reason, setReason] = useState('');
  const [source, setSource] = useState<'manual' | 'holiday'>('manual');
  const [attempted, setAttempted] = useState<'preview' | 'create' | null>(null);
  const [preview, setPreview] = useState<PreviewQuery | null>(null);
  const create = useApiCommand('post', '/closures', { invalidate: [CLOSURES_KEY] });

  const startAt = toInstant(start, tz);
  const endAt = toInstant(end, tz);
  const areaProblems = [
    !scope ? 'Choose the whole facility or one space.' : null,
    scope === 'space' && resourceId.length === 0 ? 'Choose the space to close.' : null,
    startAt.ok && endAt.ok && startAt.instant >= endAt.instant
      ? 'The end must be after the start.'
      : null,
  ].filter((p): p is string => p !== null);
  const reasonProblem = !reason.trim() ? 'Enter the reason for the closure.' : null;
  const problems =
    attempted === 'create' && reasonProblem ? [...areaProblems, reasonProblem] : areaProblems;
  const current: PreviewQuery | null =
    areaProblems.length === 0 && startAt.ok && endAt.ok
      ? {
          facilityId: facility.id,
          ...(scope === 'space' && resourceId[0] ? { resourceId: resourceId[0] } : {}),
          start: startAt.instant,
          end: endAt.instant,
        }
      : null;
  const impact = useApiQuery({
    path: '/closure-impact',
    request: { query: preview ?? { facilityId: facility.id, start: '', end: '' } },
    enabled: preview !== null,
    refetchOnWindowFocus: false,
  });
  // The preview shown must be of what would be created (same area and interval).
  const previewCurrent =
    preview !== null && current !== null && JSON.stringify(preview) === JSON.stringify(current);

  const runPreview = (e?: FormEvent) => {
    e?.preventDefault();
    setAttempted('preview');
    if (!current) return;
    setPreview(current);
    if (previewCurrent) void impact.refetch();
  };

  const submit = () => {
    setAttempted('create');
    if (!current || !previewCurrent || reasonProblem) return;
    void create
      .submit({
        body: {
          facilityId: current.facilityId,
          ...(current.resourceId ? { resourceId: current.resourceId } : {}),
          interval: { start: current.start, end: current.end },
          reason: reason.trim(),
          source,
        },
      })
      .then((closure) => navigate(`/schedule/closures/${closure.id}`))
      .catch(() => undefined);
  };

  return (
    <form className="form" onSubmit={runPreview} aria-labelledby="new-closure-title" noValidate>
      <h4 id="new-closure-title">New closure</h4>
      <p className="caption">
        Preview what a closure would affect before creating it. Creating records it as planned;
        nothing is closed and nobody is told until you apply it.
      </p>
      <fieldset>
        <legend>What closes</legend>
        <label>
          <input
            type="radio"
            name="closure-scope"
            checked={scope === 'facility'}
            onChange={() => setScope('facility')}
          />{' '}
          The whole facility
        </label>
        <label>
          <input
            type="radio"
            name="closure-scope"
            checked={scope === 'space'}
            onChange={() => setScope('space')}
          />{' '}
          One space (a whole pitch also closes its subdivisions)
        </label>
      </fieldset>
      {scope === 'space' ? (
        <ResourceChecklist
          legend="Space"
          single
          resources={resources.data ?? []}
          value={resourceId}
          onChange={setResourceId}
        />
      ) : null}
      <LocalDateTimeField
        label="From"
        value={start}
        onChange={setStart}
        timeZone={tz}
        showErrors={attempted !== null}
      />
      <LocalDateTimeField
        label="Until"
        value={end}
        onChange={setEnd}
        timeZone={tz}
        showErrors={attempted !== null}
      />
      <label htmlFor="closure-reason">Reason</label>
      <input
        id="closure-reason"
        value={reason}
        maxLength={2000}
        onChange={(e) => setReason(e.target.value)}
      />
      <label htmlFor="closure-source">Kind</label>
      <select
        id="closure-source"
        value={source}
        onChange={(e) => setSource(e.target.value === 'holiday' ? 'holiday' : 'manual')}
      >
        <option value="manual">Closure</option>
        <option value="holiday">Holiday closure</option>
      </select>
      <p className="caption">
        Maintenance restrictions are applied from Facilities and maintenance, so their release
        follows the inspection rules.
      </p>
      {attempted && problems.length > 0 ? (
        <ul className="field-issues" aria-label="Problems to correct">
          {problems.map((p) => (
            <li key={p} className="error-text">
              {p}
            </li>
          ))}
        </ul>
      ) : null}
      <Button type="submit" variant="secondary" busy={impact.isFetching} disabled={!online}>
        Preview impact
      </Button>
      {!online ? <p className="caption">Previewing and creating need a connection.</p> : null}
      {preview !== null && !previewCurrent ? (
        <p role="status" className="caption" data-testid="preview-outdated">
          The area or times changed since the preview. Preview the impact again before creating the
          closure.
        </p>
      ) : null}
      {previewCurrent && impact.error ? (
        <PreviewError error={impact.error} onRetry={() => void impact.refetch()} />
      ) : null}
      {previewCurrent && !impact.error && !impact.data ? (
        <StateView variant="loading" label="the impact preview" />
      ) : null}
      {previewCurrent && impact.data ? (
        <section aria-labelledby="closure-preview-title" data-testid="closure-preview">
          <h5 id="closure-preview-title">
            Impact preview
            {impact.updatedAt ? ` at ${formatInstant(impact.updatedAt, tz)}` : ''}
          </h5>
          <p className="caption">Nothing has been created or closed.</p>
          <ImpactSummary impact={impact.data} caption="What this closure would affect" />
          <AffectedEventList
            impact={impact.data}
            names={resourceNames(resources.data ?? [])}
            timeZone={tz}
          />
          <ImpactParties impact={impact.data} />
          <Button busy={create.isProcessing} disabled={!online} onClick={submit}>
            Create pending closure
          </Button>
          <p className="caption">The impact is computed again when the closure is created.</p>
        </section>
      ) : null}
      {create.error ? (
        <CommandError error={create.error} onRetry={submit} action="Creating a closure" />
      ) : null}
    </form>
  );
}

function ClosureList({ facility }: { facility: FacilityContext }) {
  const [status, setStatus] = useState<'' | ClosureStatus>('');
  const closures = useApiQuery({
    path: '/closures',
    request: { query: { facilityId: facility.id, ...(status ? { status } : {}) } },
  });
  const resources = useApiQuery({
    path: '/resources',
    request: { query: { facilityId: facility.id } },
  });
  const names = resourceNames(resources.data ?? []);
  return (
    <div>
      <label>
        Show{' '}
        <select value={status} onChange={(e) => setStatus(e.target.value as '' | ClosureStatus)}>
          <option value="">All closures</option>
          <option value="pending">pending</option>
          <option value="active">active</option>
          <option value="lifted">lifted</option>
          <option value="withdrawn">withdrawn</option>
        </select>
      </label>
      <QueryBoundary
        query={closures}
        label="closures"
        isEmpty={(list) => list.length === 0}
        empty={{
          title: 'No closures',
          description:
            'Closures of the facility or of a space, and maintenance restrictions, appear here.',
        }}
        unavailableOffline={['creating, applying or lifting closures']}
      >
        {(list) => (
          <ul className="list" aria-label="Closures">
            {[...list]
              .sort((a, b) => b.interval.start.localeCompare(a.interval.start))
              .map((c) => (
                <li key={c.id}>
                  <div className="row-text">
                    <Link className="row-title" to={`/schedule/closures/${c.id}`}>
                      {SOURCE_LABEL[c.source]}: {c.reason}
                    </Link>
                    <span className="caption">
                      {c.resourceId ? (names.get(c.resourceId) ?? 'A space') : 'Whole facility'} ·{' '}
                      {formatRange(c.interval.start, c.interval.end, facility.timezone)}
                      {c.impact
                        ? ` · ${c.impact.affectedEvents.length} affected event${c.impact.affectedEvents.length === 1 ? '' : 's'}`
                        : ''}
                      {c.resolution?.unresolvedEventIds.length
                        ? ` · ${c.resolution.unresolvedEventIds.length} awaiting resolution`
                        : ''}
                      {c.status === 'withdrawn' && c.withdrawalReason
                        ? ` · withdrawn: ${c.withdrawalReason}`
                        : ''}
                    </span>
                  </div>
                  <StatusBadge
                    tone={CLOSURE_BADGE[c.status].tone}
                    label={CLOSURE_BADGE[c.status].label}
                  />
                </li>
              ))}
          </ul>
        )}
      </QueryBoundary>
    </div>
  );
}

export function ClosuresScreen() {
  return (
    <section aria-labelledby="closures-title">
      <h3 id="closures-title">Closures</h3>
      <FacilityGate purpose="see and plan its closures">
        {(facility) => (
          <>
            <ZoneCaption facility={facility} />
            <ActionGate
              action="scheduling.manage_closures"
              facilityId={facility.id}
              what="Previewing and creating closures"
            >
              <NewClosureForm facility={facility} />
            </ActionGate>
            <ClosureList facility={facility} />
          </>
        )}
      </FacilityGate>
    </section>
  );
}
