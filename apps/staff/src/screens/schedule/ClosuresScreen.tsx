/**
 * SCR-S-06 entry: the facility's closures and "New closure" (SPK-SCHED-009, SPK-FAC-003). Creating
 * a closure (`POST /v1/closures`) records it as `pending` with its impact preview and closes
 * nothing yet; the detail screen reviews the impact and applies it. Closures from maintenance
 * restrictions are listed with their source; their return to service is a release on SCR-S-42.
 */
import type { Schema } from '@sportspark/api-client';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { useApp } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { StatusBadge } from '../../ui/StatusBadge';
import { CommandError } from '../../features/schedule-facilities/CommandError';
import {
  FacilityGate,
  ZoneCaption,
  type FacilityContext,
} from '../../features/schedule-facilities/facility-scope';
import { resourceNames } from '../../features/schedule-facilities/inventory';
import { CLOSURE_BADGE } from '../../features/schedule-facilities/labels';
import {
  LocalDateTimeField,
  emptyLocal,
  toInstant,
  type LocalDateTime,
} from '../../features/schedule-facilities/LocalDateTimeField';
import { ResourceChecklist } from '../../features/schedule-facilities/ResourceChecklist';
import { formatRange } from '../../features/schedule-facilities/time';

type ClosureStatus = Schema<'Closure'>['status'];
export const CLOSURES_KEY = ['api', '/closures'] as const;

const SOURCE_LABEL: Record<Schema<'Closure'>['source'], string> = {
  manual: 'Closure',
  holiday: 'Holiday closure',
  maintenance: 'Maintenance restriction',
};

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
  const [attempted, setAttempted] = useState(false);
  const create = useApiCommand('post', '/closures', { invalidate: [CLOSURES_KEY] });

  const startAt = toInstant(start, tz);
  const endAt = toInstant(end, tz);
  const problems = [
    !scope ? 'Choose the whole facility or one space.' : null,
    scope === 'space' && resourceId.length === 0 ? 'Choose the space to close.' : null,
    !reason.trim() ? 'Enter the reason for the closure.' : null,
    startAt.ok && endAt.ok && startAt.instant >= endAt.instant
      ? 'The end must be after the start.'
      : null,
  ].filter((p): p is string => p !== null);

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    setAttempted(true);
    if (problems.length > 0 || !startAt.ok || !endAt.ok) return;
    void create
      .submit({
        body: {
          facilityId: facility.id,
          ...(scope === 'space' && resourceId[0] ? { resourceId: resourceId[0] } : {}),
          interval: { start: startAt.instant, end: endAt.instant },
          reason: reason.trim(),
          source,
        },
      })
      .then((closure) => navigate(`/schedule/closures/${closure.id}`))
      .catch(() => undefined);
  };

  return (
    <form className="form" onSubmit={submit} aria-labelledby="new-closure-title" noValidate>
      <h4 id="new-closure-title">New closure</h4>
      <p className="caption">
        Creating a closure shows what it affects. Nothing is closed and nobody is told until you
        apply it.
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
        showErrors={attempted}
      />
      <LocalDateTimeField
        label="Until"
        value={end}
        onChange={setEnd}
        timeZone={tz}
        showErrors={attempted}
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
      <Button type="submit" busy={create.isProcessing} disabled={!online}>
        Preview impact
      </Button>
      {create.error ? (
        <CommandError error={create.error} onRetry={() => submit()} action="Creating a closure" />
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
            <NewClosureForm facility={facility} />
            <ClosureList facility={facility} />
          </>
        )}
      </FacilityGate>
    </section>
  );
}
