/**
 * SCR-S-04 entry: the facility's schedule drafts and "New draft" (SPK-SCHED-005). Lists
 * `GET /v1/schedule-drafts` with each draft's status ("Draft (autosaved <time>)", "Validation
 * failed", "Published"), author, last save and number of changes; opens a draft with
 * `POST /v1/schedule-drafts` (idempotency key per intent). Drafts send no customer notices.
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
import { ActionGate } from '../../features/schedule-facilities/permission';
import {
  FacilityGate,
  type FacilityContext,
} from '../../features/schedule-facilities/facility-scope';
import { draftBadge } from '../../features/schedule-facilities/labels';
import { formatInstant, localTimeOf } from '../../features/schedule-facilities/time';

type DraftStatus = Schema<'ScheduleDraft'>['status'];

const STATUS_FILTERS: { value: '' | DraftStatus; label: string }[] = [
  { value: '', label: 'All drafts' },
  { value: 'editing', label: 'editing' },
  { value: 'validated', label: 'validated' },
  { value: 'failed', label: 'failed' },
  { value: 'published', label: 'published' },
  { value: 'discarded', label: 'discarded' },
];

export const DRAFTS_KEY = ['api', '/schedule-drafts'] as const;

function NewDraftForm({ facility }: { facility: FacilityContext }) {
  const navigate = useNavigate();
  const { online } = useApp();
  const [name, setName] = useState('');
  const [touched, setTouched] = useState(false);
  const create = useApiCommand('post', '/schedule-drafts', { invalidate: [DRAFTS_KEY] });
  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    setTouched(true);
    if (!name.trim()) return;
    void create
      .submit({ body: { facilityId: facility.id, name: name.trim() } })
      .then((draft) => navigate(`/schedule/drafts/${draft.id}`))
      .catch(() => undefined);
  };
  return (
    <form className="form" onSubmit={submit} aria-labelledby="new-draft-title">
      <h4 id="new-draft-title">New draft</h4>
      <label htmlFor="new-draft-name">Draft name</label>
      <input
        id="new-draft-name"
        value={name}
        maxLength={200}
        aria-invalid={touched && !name.trim() ? true : undefined}
        aria-describedby={touched && !name.trim() ? 'new-draft-name-error' : undefined}
        onChange={(e) => setName(e.target.value)}
      />
      {touched && !name.trim() ? (
        <span className="error-text" id="new-draft-name-error">
          Enter a name for the draft.
        </span>
      ) : null}
      <Button type="submit" busy={create.isProcessing} disabled={!online}>
        Open draft
      </Button>
      {!online ? <p className="caption">Opening a draft needs a connection.</p> : null}
      {create.error ? (
        <CommandError error={create.error} onRetry={() => submit()} action="Opening a draft" />
      ) : null}
    </form>
  );
}

function DraftList({ facility }: { facility: FacilityContext }) {
  const [status, setStatus] = useState<'' | DraftStatus>('');
  const drafts = useApiQuery({
    path: '/schedule-drafts',
    request: { query: { facilityId: facility.id, ...(status ? { status } : {}) } },
  });
  return (
    <div>
      <label>
        Show{' '}
        <select value={status} onChange={(e) => setStatus(e.target.value as '' | DraftStatus)}>
          {STATUS_FILTERS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
      </label>
      <QueryBoundary
        query={drafts}
        label="schedule drafts"
        isEmpty={(list) => list.length === 0}
        empty={{
          title: 'No drafts',
          description:
            'Schedule changes are prepared in drafts, validated, then published together. Open a new draft to start.',
        }}
        unavailableOffline={['opening, saving or publishing drafts']}
      >
        {(list) => (
          <ul className="list" aria-label="Schedule drafts">
            {[...list]
              .sort((a, b) => b.lastSavedAt.localeCompare(a.lastSavedAt))
              .map((d) => {
                const badge = draftBadge(d.status, localTimeOf(d.lastSavedAt, facility.timezone));
                return (
                  <li key={d.id}>
                    <div className="row-text">
                      <Link className="row-title" to={`/schedule/drafts/${d.id}`}>
                        {d.name}
                      </Link>
                      <span className="caption">
                        {d.changes.length} change{d.changes.length === 1 ? '' : 's'} · Author:{' '}
                        {d.author.actorLabel || 'not recorded'} · Last saved{' '}
                        {formatInstant(d.lastSavedAt, facility.timezone)}
                        {d.publishedAt
                          ? ` · Published ${formatInstant(d.publishedAt, facility.timezone)}`
                          : ''}
                      </span>
                    </div>
                    <StatusBadge tone={badge.tone} label={badge.label} />
                  </li>
                );
              })}
          </ul>
        )}
      </QueryBoundary>
    </div>
  );
}

export function ScheduleDraftsScreen() {
  return (
    <section aria-labelledby="drafts-title">
      <h3 id="drafts-title">Drafts and publication</h3>
      <p className="caption">
        Drafts are saved automatically and send no notices to customers. Publishing a draft commits
        all of its changes together or none of them.
      </p>
      <FacilityGate purpose="work on its schedule drafts">
        {(facility) => (
          <>
            <ActionGate
              action="scheduling.manage_drafts"
              facilityId={facility.id}
              what="Opening schedule drafts"
            >
              <NewDraftForm facility={facility} />
            </ActionGate>
            <DraftList facility={facility} />
          </>
        )}
      </FacilityGate>
    </section>
  );
}
