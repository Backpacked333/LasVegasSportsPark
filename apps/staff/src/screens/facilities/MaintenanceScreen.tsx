/**
 * SCR-S-41 Assets and maintenance tasks (SPK-FAC-001, SPK-FAC-002, SPK-FAC-005). Per facility:
 *
 * - Maintenance tasks (`GET /v1/maintenance-tasks`): asset or space, issue, severity, reporter,
 *   evidence, owner, due date, open operating restrictions, resolution and latest inspection;
 *   overdue tasks are marked in text. Each opens the task screen.
 * - Report an issue (`POST /v1/maintenance-tasks`, any staff): asset or space and severity are
 *   required (validation failure "severity or owner missing" is caught before sending); an empty due
 *   date leaves the configured default for the severity to the API (pending operations decision).
 * - Assets (`GET/POST/PATCH/DELETE /v1/assets`): turf, goals, nets, boards, dividers, lighting,
 *   scoreboards, equipment; retiring keeps history.
 * - Preventive maintenance (`/v1/preventive-schedules`): recurring tasks that create future
 *   restrictions through the scheduling authority; "Generate due occurrences" materializes them.
 *
 * Offline: read-only with the age of what is shown; reporting, evidence and edits need a connection
 * (no queued evidence upload is offered).
 */
import type { Schema } from '@sportspark/api-client';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { useApp, useNow } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';
import { CommandError } from '../../features/schedule-facilities/CommandError';
import { useCommandReload } from '../../features/schedule-facilities/reload';
import {
  FacilityGate,
  ZoneCaption,
  type FacilityContext,
} from '../../features/schedule-facilities/facility-scope';
import {
  ASSET_BADGE,
  ASSET_KIND_LABEL,
  PREVENTIVE_BADGE,
  SEVERITY_BADGE,
  TASK_BADGE,
  WEEKDAY_LABEL,
} from '../../features/schedule-facilities/labels';
import {
  LocalDateTimeField,
  emptyLocal,
  toInstant,
  type LocalDateTime,
} from '../../features/schedule-facilities/LocalDateTimeField';
import { formatInstant } from '../../features/schedule-facilities/time';
import {
  ASSETS_KEY,
  EvidenceEditor,
  TASKS_KEY,
  evidenceInput,
  useFacilityNames,
  useMyPersonId,
  whereLabel,
  type EvidenceDraft,
} from './maintenance-shared';

type Task = Schema<'MaintenanceTask'>;
type Severity = Task['severity'];
type TaskStatus = Task['status'];
type Asset = Schema<'Asset'>;
type AssetKind = Asset['kind'];

const SEVERITIES: Severity[] = ['low', 'medium', 'high', 'critical'];
const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const PAGE = 50;
const MAX_LIMIT = 200;

export function isOverdue(task: Task, now: Date): boolean {
  return (
    task.dueAt !== null &&
    new Date(task.dueAt).getTime() < now.getTime() &&
    task.status !== 'resolved' &&
    task.status !== 'closed'
  );
}

function TaskList({ facility }: { facility: FacilityContext }) {
  const now = useNow();
  const me = useMyPersonId();
  const { assetNames, resourceNames } = useFacilityNames(facility.id);
  const [status, setStatus] = useState<'' | TaskStatus>('');
  const [severity, setSeverity] = useState<'' | Severity>('');
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [limit, setLimit] = useState(PAGE);
  const tasks = useApiQuery({
    path: '/maintenance-tasks',
    request: {
      query: {
        facilityId: facility.id,
        limit,
        ...(status ? { status } : {}),
        ...(severity ? { severity } : {}),
        // The flag is the string 'true' or 'false' (QueryBoolean, FAC-01); only 'true' is sent.
        ...(overdueOnly ? { overdue: 'true' as const } : {}),
      },
    },
  });
  return (
    <section aria-labelledby="tasks-title">
      <h4 id="tasks-title">Maintenance tasks</h4>
      <div className="toolbar" role="group" aria-label="Task filters">
        <label>
          Status{' '}
          <select value={status} onChange={(e) => setStatus(e.target.value as '' | TaskStatus)}>
            <option value="">Any</option>
            {(Object.keys(TASK_BADGE) as TaskStatus[]).map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label>
          Severity{' '}
          <select value={severity} onChange={(e) => setSeverity(e.target.value as '' | Severity)}>
            <option value="">Any</option>
            {SEVERITIES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label>
          <input
            type="checkbox"
            checked={overdueOnly}
            onChange={(e) => setOverdueOnly(e.target.checked)}
          />{' '}
          Overdue only
        </label>
      </div>
      <QueryBoundary
        query={tasks}
        label="maintenance tasks"
        isEmpty={(page) => page.items.length === 0}
        empty={{
          title: status || severity || overdueOnly ? 'No tasks match' : 'No maintenance tasks',
          description:
            'Issues reported by any staff member appear here with their severity and owner.',
        }}
        unavailableOffline={['reporting issues, assigning, resolving or closing tasks']}
      >
        {(page) => (
          <>
            <ul className="list" aria-label="Maintenance tasks">
              {[...page.items]
                .sort(
                  (a, b) =>
                    Number(a.status === 'closed') - Number(b.status === 'closed') ||
                    SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
                    (a.dueAt ?? '9999').localeCompare(b.dueAt ?? '9999'),
                )
                .map((t) => {
                  const sev = SEVERITY_BADGE[t.severity];
                  const st = TASK_BADGE[t.status];
                  return (
                    <li key={t.id} data-testid={`task-${t.id}`}>
                      <div className="row-text">
                        <Link className="row-title" to={`/facilities/maintenance/tasks/${t.id}`}>
                          {t.issue}
                        </Link>
                        <span className="caption">
                          {whereLabel(t, assetNames, resourceNames)} · Reported by{' '}
                          {t.reporter.actorLabel || 'staff'}{' '}
                          {formatInstant(t.reportedAt, facility.timezone)} · Owner:{' '}
                          {t.assignedOwnerPersonId === null
                            ? 'unassigned'
                            : t.assignedOwnerPersonId === me
                              ? 'you'
                              : 'assigned'}
                          {t.dueAt ? ` · Due ${formatInstant(t.dueAt, facility.timezone)}` : ''}
                          {t.requiresInspection ? ' · Inspection required' : ''}
                          {t.latestInspection
                            ? ` · Last inspection ${t.latestInspection.outcome}`
                            : ''}
                          {t.openRestrictionIds.length
                            ? ` · ${t.openRestrictionIds.length} restriction${t.openRestrictionIds.length === 1 ? '' : 's'} not released`
                            : ''}
                        </span>
                      </div>
                      <span>
                        <StatusBadge tone={sev.tone} label={sev.label} />{' '}
                        <StatusBadge tone={st.tone} label={`Status: ${st.label}`} />
                        {isOverdue(t, now) ? (
                          <>
                            {' '}
                            <StatusBadge tone="danger" label="Overdue" />
                          </>
                        ) : null}
                      </span>
                    </li>
                  );
                })}
            </ul>
            {page.nextCursor ? (
              limit < MAX_LIMIT ? (
                <Button
                  variant="secondary"
                  onClick={() => setLimit((l) => Math.min(MAX_LIMIT, l + PAGE))}
                >
                  Show more tasks
                </Button>
              ) : (
                <p className="caption">More tasks exist; narrow the filters to see them.</p>
              )
            ) : null}
          </>
        )}
      </QueryBoundary>
    </section>
  );
}

function ReportIssueForm({ facility }: { facility: FacilityContext }) {
  const { online } = useApp();
  const tz = facility.timezone;
  const { resources, assets } = useFacilityNames(facility.id);
  const [target, setTarget] = useState('');
  const [issue, setIssue] = useState('');
  const [severity, setSeverity] = useState<'' | Severity>('');
  const [due, setDue] = useState<LocalDateTime>(emptyLocal());
  const [inspection, setInspection] = useState(false);
  const [evidence, setEvidence] = useState<EvidenceDraft[]>([]);
  const [attempted, setAttempted] = useState(false);
  const [reported, setReported] = useState<Task | null>(null);
  const report = useApiCommand('post', '/maintenance-tasks', { invalidate: [TASKS_KEY] });
  const dueAt = due.date || due.time ? toInstant(due, tz) : null;
  const problems = [
    !target ? 'Choose the asset or space.' : null,
    !issue.trim() ? 'Describe the issue.' : null,
    !severity ? 'Choose a severity.' : null,
    dueAt && !dueAt.ok ? dueAt.message : null,
  ].filter((p): p is string => p !== null);
  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    setAttempted(true);
    if (problems.length > 0 || !severity) return;
    const [kind, id] = target.split(':');
    void report
      .submit({
        body: {
          facilityId: facility.id,
          ...(kind === 'asset' ? { assetId: id } : { resourceId: id }),
          issue: issue.trim(),
          severity,
          ...(dueAt?.ok ? { dueAt: dueAt.instant } : {}),
          requiresInspection: inspection,
          ...(evidenceInput(evidence).length ? { evidence: evidenceInput(evidence) } : {}),
        },
      })
      .then((task) => {
        setReported(task);
        setTarget('');
        setIssue('');
        setSeverity('');
        setDue(emptyLocal());
        setInspection(false);
        setEvidence([]);
        setAttempted(false);
      })
      .catch(() => undefined);
  };
  return (
    <form className="form" onSubmit={submit} aria-labelledby="report-title" noValidate>
      <h4 id="report-title">Report an issue</h4>
      <label htmlFor="report-target">Asset or space</label>
      <select id="report-target" value={target} onChange={(e) => setTarget(e.target.value)}>
        <option value="">Choose…</option>
        <optgroup label="Spaces">
          {(resources.data ?? []).map((r) => (
            <option key={r.id} value={`resource:${r.id}`}>
              {r.name}
            </option>
          ))}
        </optgroup>
        <optgroup label="Assets">
          {(assets.data ?? [])
            .filter((a) => a.status !== 'retired')
            .map((a) => (
              <option key={a.id} value={`asset:${a.id}`}>
                {a.name} ({ASSET_KIND_LABEL[a.kind]})
              </option>
            ))}
        </optgroup>
      </select>
      <label htmlFor="report-issue">Issue</label>
      <textarea
        id="report-issue"
        rows={3}
        value={issue}
        maxLength={4000}
        onChange={(e) => setIssue(e.target.value)}
      />
      <fieldset>
        <legend>Severity</legend>
        {SEVERITIES.map((s) => (
          <label key={s}>
            <input
              type="radio"
              name="report-severity"
              checked={severity === s}
              onChange={() => setSeverity(s)}
            />{' '}
            {s}
          </label>
        ))}
      </fieldset>
      <LocalDateTimeField label="Due (optional)" value={due} onChange={setDue} timeZone={tz} />
      <p className="caption">
        Leave the due date empty to use the proposed default for the severity; the confirmation
        shows the due time the service chose.
      </p>
      <StateView
        variant="pending-decision"
        subject="Default due times per severity"
        decisions={['DEC-001']}
        owner="Operations"
      />
      <label>
        <input
          type="checkbox"
          checked={inspection}
          onChange={(e) => setInspection(e.target.checked)}
        />{' '}
        An inspection is required before the area returns to service
      </label>
      <EvidenceEditor value={evidence} onChange={setEvidence} idPrefix="report-evidence" />
      {attempted && problems.length > 0 ? (
        <ul className="field-issues" aria-label="Problems to correct">
          {problems.map((p) => (
            <li key={p} className="error-text">
              {p}
            </li>
          ))}
        </ul>
      ) : null}
      <Button type="submit" busy={report.isProcessing} disabled={!online}>
        Report issue
      </Button>
      {!online ? <p className="caption">Reporting an issue needs a connection.</p> : null}
      {report.error ? (
        <CommandError error={report.error} onRetry={() => submit()} action="Reporting an issue" />
      ) : null}
      {reported ? (
        <p role="status">
          Reported:{' '}
          <Link to={`/facilities/maintenance/tasks/${reported.id}`}>{reported.issue}</Link> (status{' '}
          {reported.status}
          {reported.dueAt ? `, due ${formatInstant(reported.dueAt, tz)}` : ''}).
        </p>
      ) : null}
    </form>
  );
}

function AssetRow({ asset, facility }: { asset: Asset; facility: FacilityContext }) {
  const { online } = useApp();
  const { resources, resourceNames } = useFacilityNames(facility.id);
  const [editing, setEditing] = useState(false);
  const [confirmRetire, setConfirmRetire] = useState(false);
  const [name, setName] = useState(asset.name);
  const [identifier, setIdentifier] = useState(asset.identifier ?? '');
  const [resourceId, setResourceId] = useState(asset.resourceId ?? '');
  const [status, setStatus] = useState<'in_service' | 'out_of_service'>(
    asset.status === 'out_of_service' ? 'out_of_service' : 'in_service',
  );
  const save = useApiCommand('patch', '/assets/{id}', { invalidate: [ASSETS_KEY] });
  const retire = useApiCommand('delete', '/assets/{id}', { invalidate: [ASSETS_KEY] });
  const reloadSave = useCommandReload(save.reset, [ASSETS_KEY]);
  const reloadRetire = useCommandReload(retire.reset, [ASSETS_KEY]);
  const badge = ASSET_BADGE[asset.status];
  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (!name.trim()) return;
    void save
      .submit({
        path: { id: asset.id },
        body: {
          expectedRevision: asset.revision,
          name: name.trim(),
          identifier: identifier.trim() || null,
          resourceId: resourceId || null,
          // A restricted asset follows its restrictions; only in or out of service is chosen here.
          ...(asset.status !== 'restricted' ? { status } : {}),
        },
      })
      .then(() => setEditing(false))
      .catch(() => undefined);
  };
  const doRetire = () =>
    void retire
      .submit({ path: { id: asset.id }, body: { expectedRevision: asset.revision } })
      .then(() => setConfirmRetire(false))
      .catch(() => undefined);
  const prefix = `asset-${asset.id}`;
  return (
    <li>
      <div className="row-text">
        <span className="row-title">{asset.name}</span>
        <span className="caption">
          {ASSET_KIND_LABEL[asset.kind]}
          {asset.identifier ? ` · ${asset.identifier}` : ''} ·{' '}
          {asset.resourceId
            ? (resourceNames.get(asset.resourceId) ?? 'a space')
            : 'not attached to a space'}
        </span>
      </div>
      <StatusBadge tone={badge.tone} label={badge.label} />
      {asset.status !== 'retired' && !editing ? (
        <span className="field-row">
          <Button
            variant="secondary"
            aria-label={`Edit ${asset.name}`}
            onClick={() => setEditing(true)}
          >
            Edit
          </Button>
          {confirmRetire ? (
            <>
              <Button busy={retire.isProcessing} disabled={!online} onClick={doRetire}>
                Confirm retire {asset.name}
              </Button>
              <Button variant="secondary" onClick={() => setConfirmRetire(false)}>
                Keep
              </Button>
            </>
          ) : (
            <Button
              variant="secondary"
              aria-label={`Retire ${asset.name}`}
              onClick={() => setConfirmRetire(true)}
            >
              Retire
            </Button>
          )}
        </span>
      ) : null}
      {editing ? (
        <form className="form" onSubmit={submit} aria-label={`Edit ${asset.name}`} noValidate>
          <label htmlFor={`${prefix}-name`}>Name</label>
          <input
            id={`${prefix}-name`}
            value={name}
            maxLength={200}
            onChange={(e) => setName(e.target.value)}
          />
          <label htmlFor={`${prefix}-identifier`}>Identifier</label>
          <input
            id={`${prefix}-identifier`}
            value={identifier}
            maxLength={100}
            onChange={(e) => setIdentifier(e.target.value)}
          />
          <label htmlFor={`${prefix}-space`}>Space</label>
          <select
            id={`${prefix}-space`}
            value={resourceId}
            onChange={(e) => setResourceId(e.target.value)}
          >
            <option value="">Not attached to a space</option>
            {(resources.data ?? []).map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
          {asset.status !== 'restricted' ? (
            <>
              <label htmlFor={`${prefix}-status`}>Status</label>
              <select
                id={`${prefix}-status`}
                value={status}
                onChange={(e) =>
                  setStatus(e.target.value === 'out_of_service' ? 'out_of_service' : 'in_service')
                }
              >
                <option value="in_service">in_service</option>
                <option value="out_of_service">out_of_service</option>
              </select>
            </>
          ) : (
            <p className="caption">
              This asset is restricted; it returns to service when its restriction is released.
            </p>
          )}
          <span className="field-row">
            <Button type="submit" busy={save.isProcessing} disabled={!online || !name.trim()}>
              Save
            </Button>
            <Button variant="secondary" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </span>
        </form>
      ) : null}
      {save.error ? (
        <CommandError
          error={save.error}
          onRetry={() => submit()}
          onReload={reloadSave}
          action="Saving the asset"
        />
      ) : null}
      {retire.error ? (
        <CommandError
          error={retire.error}
          onRetry={doRetire}
          onReload={reloadRetire}
          action="Retiring the asset"
        />
      ) : null}
    </li>
  );
}

function Assets({ facility }: { facility: FacilityContext }) {
  const { online } = useApp();
  const [includeRetired, setIncludeRetired] = useState(false);
  const assets = useApiQuery({
    path: '/assets',
    request: {
      query: {
        facilityId: facility.id,
        ...(includeRetired ? { includeRetired: 'true' as const } : {}),
      },
    },
  });
  const { resources } = useFacilityNames(facility.id);
  const [kind, setKind] = useState<'' | AssetKind>('');
  const [name, setName] = useState('');
  const [identifier, setIdentifier] = useState('');
  const [resourceId, setResourceId] = useState('');
  const [attempted, setAttempted] = useState(false);
  const create = useApiCommand('post', '/assets', { invalidate: [ASSETS_KEY] });
  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    setAttempted(true);
    if (!kind || !name.trim()) return;
    void create
      .submit({
        body: {
          facilityId: facility.id,
          kind,
          name: name.trim(),
          ...(identifier.trim() ? { identifier: identifier.trim() } : {}),
          ...(resourceId ? { resourceId } : {}),
        },
      })
      .then(() => {
        setKind('');
        setName('');
        setIdentifier('');
        setResourceId('');
        setAttempted(false);
      })
      .catch(() => undefined);
  };
  return (
    <section aria-labelledby="assets-title">
      <h4 id="assets-title">Assets</h4>
      <label>
        <input
          type="checkbox"
          checked={includeRetired}
          onChange={(e) => setIncludeRetired(e.target.checked)}
        />{' '}
        Include retired assets
      </label>
      <QueryBoundary
        query={assets}
        label="assets"
        isEmpty={(list) => list.length === 0}
        empty={{
          title: 'No assets',
          description:
            'Turf areas, goals, nets, boards, dividers, lighting, scoreboards and equipment appear here once registered.',
        }}
        unavailableOffline={['registering, editing or retiring assets']}
      >
        {(list) => (
          <ul className="list" aria-label="Assets">
            {list.map((a) => (
              <AssetRow key={`${a.id}-${a.revision}`} asset={a} facility={facility} />
            ))}
          </ul>
        )}
      </QueryBoundary>
      <form className="form" onSubmit={submit} aria-labelledby="new-asset-title" noValidate>
        <h5 id="new-asset-title">Register an asset</h5>
        <label htmlFor="new-asset-kind">Kind</label>
        <select
          id="new-asset-kind"
          value={kind}
          onChange={(e) => setKind(e.target.value as '' | AssetKind)}
        >
          <option value="">Choose…</option>
          {(Object.keys(ASSET_KIND_LABEL) as AssetKind[]).map((k) => (
            <option key={k} value={k}>
              {ASSET_KIND_LABEL[k]}
            </option>
          ))}
        </select>
        {attempted && !kind ? <span className="error-text">Choose the kind of asset.</span> : null}
        <label htmlFor="new-asset-name">Name</label>
        <input
          id="new-asset-name"
          value={name}
          maxLength={200}
          onChange={(e) => setName(e.target.value)}
        />
        {attempted && !name.trim() ? <span className="error-text">Enter a name.</span> : null}
        <label htmlFor="new-asset-identifier">Identifier (optional, unique in the facility)</label>
        <input
          id="new-asset-identifier"
          value={identifier}
          maxLength={100}
          onChange={(e) => setIdentifier(e.target.value)}
        />
        <label htmlFor="new-asset-space">Space (optional)</label>
        <select
          id="new-asset-space"
          value={resourceId}
          onChange={(e) => setResourceId(e.target.value)}
        >
          <option value="">Not attached to a space</option>
          {(resources.data ?? []).map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
        <Button type="submit" busy={create.isProcessing} disabled={!online}>
          Register asset
        </Button>
        {create.error ? (
          <CommandError
            error={create.error}
            onRetry={() => submit()}
            action="Registering an asset"
          />
        ) : null}
      </form>
    </section>
  );
}

function recurrenceText(s: Schema<'PreventiveSchedule'>): string {
  const r = s.recurrence;
  const interval = r.interval ?? 1;
  const every =
    interval > 1 ? `every ${interval} ${r.frequency === 'daily' ? 'days' : 'weeks'}` : r.frequency;
  const days = r.byWeekday?.length
    ? ` on ${r.byWeekday.map((d) => WEEKDAY_LABEL[d] ?? d).join(', ')}`
    : '';
  const bound = r.until ? ` until ${r.until}` : r.count ? `, ${r.count} times` : '';
  return `${every}${days} from ${r.startDate}${bound} at ${s.localStartTime} for ${s.durationMinutes} min`;
}

function PreventiveRow({
  schedule,
  facility,
}: {
  schedule: Schema<'PreventiveSchedule'>;
  facility: FacilityContext;
}) {
  const { online } = useApp();
  const generate = useApiCommand('post', '/preventive-schedules/{id}/generate', {
    invalidate: [['api', '/preventive-schedules'], TASKS_KEY],
  });
  const change = useApiCommand('patch', '/preventive-schedules/{id}', {
    invalidate: [['api', '/preventive-schedules']],
  });
  const reloadChange = useCommandReload(change.reset, [['api', '/preventive-schedules']]);
  const badge = PREVENTIVE_BADGE[schedule.status];
  // Each generated occurrence applies a closure, so booked events in its interval are affected:
  // the user chooses what happens to them, with no default (SCR-S-42, as the closure apply panel).
  const [choosing, setChoosing] = useState(false);
  const [mode, setMode] = useState<'' | 'cancel_affected' | 'leave_for_resolution'>('');
  const [attempted, setAttempted] = useState(false);
  const run = () => {
    setAttempted(true);
    if (!mode) return;
    void generate
      .submit({ path: { id: schedule.id }, body: { resolutionMode: mode } })
      .then(() => {
        setChoosing(false);
        setAttempted(false);
      })
      .catch(() => undefined);
  };
  const [lastStatus, setLastStatus] = useState<'active' | 'paused' | 'ended' | null>(null);
  const setStatus = (status: 'active' | 'paused' | 'ended') => {
    setLastStatus(status);
    void change
      .submit({ path: { id: schedule.id }, body: { expectedRevision: schedule.revision, status } })
      .catch(() => undefined);
  };
  const modeName = `pm-generate-mode-${schedule.id}`;
  return (
    <li>
      <div className="row-text">
        <span className="row-title">{schedule.name}</span>
        <span className="caption">
          {recurrenceText(schedule)} ({schedule.timezone}) · Generated {schedule.leadTimeDays} day
          {schedule.leadTimeDays === 1 ? '' : 's'} ahead · {schedule.taskTemplate.severity} task:{' '}
          {schedule.taskTemplate.issue} · Restriction: {schedule.restrictionKind}
          {schedule.lastGeneratedThrough
            ? ` · Generated through ${formatInstant(schedule.lastGeneratedThrough, facility.timezone)}`
            : ' · Nothing generated yet'}
        </span>
        {generate.data ? (
          <span role="status">
            {generate.data.generated.length} occurrence
            {generate.data.generated.length === 1 ? '' : 's'} generated (a task and a restriction
            each); {generate.data.alreadyGeneratedOccurrenceIndexes.length} already existed.
          </span>
        ) : null}
        {generate.data && generate.data.generated.length > 0 ? (
          <ul className="list" aria-label={`Restrictions created by ${schedule.name}`}>
            {generate.data.generated.map((g) => (
              <li key={g.restrictionId}>
                <Link to={`/facilities/restrictions/${g.restrictionId}`}>
                  Restriction for occurrence {g.occurrenceIndex + 1}:{' '}
                  {formatInstant(g.interval.start, facility.timezone)}
                </Link>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <StatusBadge tone={badge.tone} label={badge.label} />
      <span className="field-row">
        {schedule.status === 'active' ? (
          <>
            <Button
              disabled={!online || choosing}
              onClick={() => setChoosing(true)}
              aria-label={`Generate due occurrences of ${schedule.name}`}
            >
              Generate due occurrences
            </Button>
            <Button
              variant="secondary"
              disabled={!online}
              onClick={() => setStatus('paused')}
              aria-label={`Pause ${schedule.name}`}
            >
              Pause
            </Button>
          </>
        ) : null}
        {schedule.status === 'paused' ? (
          <Button
            variant="secondary"
            disabled={!online}
            onClick={() => setStatus('active')}
            aria-label={`Resume ${schedule.name}`}
          >
            Resume
          </Button>
        ) : null}
        {schedule.status !== 'ended' ? (
          <Button
            variant="secondary"
            disabled={!online}
            onClick={() => setStatus('ended')}
            aria-label={`End ${schedule.name}`}
          >
            End
          </Button>
        ) : null}
      </span>
      {choosing && schedule.status === 'active' ? (
        <div className="form" role="group" aria-label={`Generate occurrences of ${schedule.name}`}>
          <fieldset>
            <legend>Each occurrence closes its area. Events already booked in those times:</legend>
            <label>
              <input
                type="radio"
                name={modeName}
                checked={mode === 'cancel_affected'}
                onChange={() => setMode('cancel_affected')}
              />{' '}
              Cancel them now (each sends a cancellation notice)
            </label>
            <label>
              <input
                type="radio"
                name={modeName}
                checked={mode === 'leave_for_resolution'}
                onChange={() => setMode('leave_for_resolution')}
              />{' '}
              Leave them for resolution (they appear in the scheduler queue on Today)
            </label>
          </fieldset>
          {attempted && !mode ? (
            <p className="error-text" role="alert">
              Choose what happens to the affected events.
            </p>
          ) : null}
          <span className="field-row">
            <Button busy={generate.isProcessing} disabled={!online} onClick={run}>
              Generate now
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                setChoosing(false);
                setAttempted(false);
              }}
            >
              Cancel
            </Button>
          </span>
        </div>
      ) : null}
      {generate.error ? (
        <CommandError error={generate.error} onRetry={run} action="Generating occurrences" />
      ) : null}
      {change.error ? (
        <CommandError
          error={change.error}
          onRetry={lastStatus ? () => setStatus(lastStatus) : undefined}
          onReload={reloadChange}
          action="Changing the schedule"
        />
      ) : null}
    </li>
  );
}

function PreventiveForm({ facility }: { facility: FacilityContext }) {
  const { online } = useApp();
  const { resources } = useFacilityNames(facility.id);
  const [name, setName] = useState('');
  const [resourceId, setResourceId] = useState('');
  const [frequency, setFrequency] = useState<'daily' | 'weekly'>('weekly');
  const [repeatEvery, setRepeatEvery] = useState('1');
  const [weekdays, setWeekdays] = useState<number[]>([]);
  const [startDate, setStartDate] = useState('');
  const [count, setCount] = useState('');
  const [until, setUntil] = useState('');
  const [localStartTime, setLocalStartTime] = useState('');
  const [duration, setDuration] = useState('');
  const [issue, setIssue] = useState('');
  const [severity, setSeverity] = useState<'' | Severity>('');
  const [inspection, setInspection] = useState(false);
  const [restrictionKind, setRestrictionKind] = useState<'closed' | 'limited'>('closed');
  const [attempted, setAttempted] = useState(false);
  const create = useApiCommand('post', '/preventive-schedules', {
    invalidate: [['api', '/preventive-schedules']],
  });
  const intervalN = Number(repeatEvery);
  const durationN = Number(duration);
  const countN = Number(count);
  const problems = [
    !name.trim() ? 'Enter a name.' : null,
    !resourceId ? 'Choose the space.' : null,
    !/^\d{4}-\d{2}-\d{2}$/.test(startDate) ? 'Enter the first date.' : null,
    !until && !count ? 'Enter an end date or a number of occurrences.' : null,
    count && !(Number.isInteger(countN) && countN >= 1 && countN <= 366)
      ? 'Occurrences: 1 to 366.'
      : null,
    !(Number.isInteger(intervalN) && intervalN >= 1 && intervalN <= 52)
      ? 'Repeat interval: 1 to 52.'
      : null,
    !/^([01]\d|2[0-3]):[0-5]\d$/.test(localStartTime) ? 'Enter the start time.' : null,
    !(Number.isInteger(durationN) && durationN >= 5 && durationN <= 10080)
      ? 'Length: 5 minutes to 7 days.'
      : null,
    !issue.trim() ? 'Describe the task.' : null,
    !severity ? 'Choose a severity.' : null,
  ].filter((p): p is string => p !== null);
  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    setAttempted(true);
    if (problems.length > 0 || !severity) return;
    void create
      .submit({
        body: {
          facilityId: facility.id,
          resourceId,
          name: name.trim(),
          recurrence: {
            frequency,
            interval: intervalN,
            startDate,
            ...(frequency === 'weekly' && weekdays.length ? { byWeekday: weekdays } : {}),
            ...(until ? { until } : {}),
            ...(count ? { count: countN } : {}),
          },
          localStartTime,
          durationMinutes: durationN,
          taskTemplate: {
            issue: issue.trim(),
            severity,
            requiresInspection: inspection,
            assignedOwnerPersonId: null,
          },
          restrictionKind,
        },
      })
      .then(() => setAttempted(false))
      .catch(() => undefined);
  };
  return (
    <form className="form" onSubmit={submit} aria-labelledby="preventive-new-title" noValidate>
      <h5 id="preventive-new-title">New preventive schedule</h5>
      <label htmlFor="pm-name">Name</label>
      <input id="pm-name" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
      <label htmlFor="pm-space">Space</label>
      <select id="pm-space" value={resourceId} onChange={(e) => setResourceId(e.target.value)}>
        <option value="">Choose…</option>
        {(resources.data ?? []).map((r) => (
          <option key={r.id} value={r.id}>
            {r.name}
          </option>
        ))}
      </select>
      <label htmlFor="pm-frequency">Repeats</label>
      <select
        id="pm-frequency"
        value={frequency}
        onChange={(e) => setFrequency(e.target.value === 'daily' ? 'daily' : 'weekly')}
      >
        <option value="weekly">Weekly</option>
        <option value="daily">Daily</option>
      </select>
      <label htmlFor="pm-interval">
        Every (number of {frequency === 'daily' ? 'days' : 'weeks'})
      </label>
      <input
        id="pm-interval"
        inputMode="numeric"
        value={repeatEvery}
        onChange={(e) => setRepeatEvery(e.target.value)}
      />
      {frequency === 'weekly' ? (
        <fieldset>
          <legend>On (empty: the first date's weekday)</legend>
          {WEEKDAY_LABEL.map((d, i) => (
            <label key={d}>
              <input
                type="checkbox"
                checked={weekdays.includes(i)}
                onChange={(e) =>
                  setWeekdays(e.target.checked ? [...weekdays, i] : weekdays.filter((w) => w !== i))
                }
              />{' '}
              {d}
            </label>
          ))}
        </fieldset>
      ) : null}
      <label htmlFor="pm-start">First date ({facility.timezone})</label>
      <input
        id="pm-start"
        type="date"
        value={startDate}
        onChange={(e) => setStartDate(e.target.value)}
      />
      <label htmlFor="pm-until">Last date (optional)</label>
      <input id="pm-until" type="date" value={until} onChange={(e) => setUntil(e.target.value)} />
      <label htmlFor="pm-count">Number of occurrences (optional)</label>
      <input
        id="pm-count"
        inputMode="numeric"
        value={count}
        onChange={(e) => setCount(e.target.value)}
      />
      <label htmlFor="pm-time">Start time ({facility.timezone})</label>
      <input
        id="pm-time"
        type="time"
        value={localStartTime}
        onChange={(e) => setLocalStartTime(e.target.value)}
      />
      <label htmlFor="pm-duration">Length in minutes</label>
      <input
        id="pm-duration"
        inputMode="numeric"
        value={duration}
        onChange={(e) => setDuration(e.target.value)}
      />
      <label htmlFor="pm-issue">Task description</label>
      <input
        id="pm-issue"
        value={issue}
        maxLength={4000}
        onChange={(e) => setIssue(e.target.value)}
      />
      <fieldset>
        <legend>Task severity</legend>
        {SEVERITIES.map((s) => (
          <label key={s}>
            <input
              type="radio"
              name="pm-severity"
              checked={severity === s}
              onChange={() => setSeverity(s)}
            />{' '}
            {s}
          </label>
        ))}
      </fieldset>
      <label>
        <input
          type="checkbox"
          checked={inspection}
          onChange={(e) => setInspection(e.target.checked)}
        />{' '}
        Each task needs an inspection before release
      </label>
      <label htmlFor="pm-restriction">Restriction during the work</label>
      <select
        id="pm-restriction"
        value={restrictionKind}
        onChange={(e) => setRestrictionKind(e.target.value === 'limited' ? 'limited' : 'closed')}
      >
        <option value="closed">closed</option>
        <option value="limited">limited (currently closes the area like closed)</option>
      </select>
      <p className="caption">
        How far ahead occurrences are generated uses the proposed default lead time; each schedule
        shows the lead time the service recorded.
      </p>
      <StateView
        variant="pending-decision"
        subject="Preventive maintenance lead time"
        decisions={['DEC-001']}
        owner="Operations"
      />
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
        Create preventive schedule
      </Button>
      {create.error ? (
        <CommandError
          error={create.error}
          onRetry={() => submit()}
          action="Creating a preventive schedule"
        />
      ) : null}
    </form>
  );
}

function Preventive({ facility }: { facility: FacilityContext }) {
  const schedules = useApiQuery({
    path: '/preventive-schedules',
    request: { query: { facilityId: facility.id } },
  });
  return (
    <section aria-labelledby="preventive-title">
      <h4 id="preventive-title">Preventive maintenance</h4>
      <p className="caption">
        Each occurrence becomes a task and a restriction on the space, made through the scheduling
        authority so bookings see it.
      </p>
      <QueryBoundary
        query={schedules}
        label="preventive schedules"
        isEmpty={(list) => list.length === 0}
        empty={{
          title: 'No preventive schedules',
          description: 'Recurring maintenance appears here.',
        }}
      >
        {(list) => (
          <ul className="list" aria-label="Preventive schedules">
            {list.map((s) => (
              <PreventiveRow key={s.id} schedule={s} facility={facility} />
            ))}
          </ul>
        )}
      </QueryBoundary>
      <PreventiveForm facility={facility} />
    </section>
  );
}

export function MaintenanceScreen() {
  return (
    <section aria-labelledby="maintenance-title">
      <h3 id="maintenance-title">Assets and maintenance tasks</h3>
      <FacilityGate purpose="see its assets and maintenance">
        {(facility) => (
          <>
            <ZoneCaption facility={facility} />
            <TaskList facility={facility} />
            <ReportIssueForm facility={facility} />
            <Assets facility={facility} />
            <Preventive facility={facility} />
          </>
        )}
      </FacilityGate>
    </section>
  );
}
