/**
 * SCR-S-41/42 release to service, led by its checklist (SPK-FAC-003, SPK-FAC-004, SPK-SCHED-009).
 * The checklist is read from what the API records: the linked maintenance task's work and
 * inspection (the release gate, R4-OPS-MODULES-03), the closure's affected bookings (recovery; it
 * does not block the release), the viewer's release authority, and the restriction's own release
 * checks (`GET /v1/maintenance-restrictions/{id}/release-checklist`, migration 0909), which staff
 * with `facilities.manage_release_checklist` add and confirm here; each confirmation records who
 * and when, and a release is refused while one is open. The task owner is named from the same
 * read. The API makes the final check when the release is sent and names the cause when it
 * refuses.
 *
 * `ActiveRestrictions` leads the facilities screens with every active restriction at the facility
 * (`GET /v1/maintenance-restrictions?status=active`), each with its checklist and the way to its
 * release. It shows nothing extra when the read fails: the restriction list below reports that.
 */
import type { Schema } from '@sportspark/api-client';
import { useState } from 'react';
import { Link } from 'react-router';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { CommandError } from '../../features/schedule-facilities/CommandError';
import { useApp } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import type { FacilityContext } from '../../features/schedule-facilities/facility-scope';
import { useActionAllowed } from '../../features/schedule-facilities/permission';
import { formatInstant } from '../../features/schedule-facilities/time';
import { useFacilityNames } from './maintenance-shared';
import './facilities.css';

type Restriction = Schema<'Restriction'>;
type Task = Schema<'MaintenanceTask'>;
type Checklist = Schema<'ReleaseChecklist'>;
type ChecklistItem = Schema<'ReleaseChecklistItem'>;

export const CHECKLIST_KEY = ['api', '/maintenance-restrictions/{id}/release-checklist'] as const;

/** The restriction's own release checks and the task owner (migration 0909). */
export function useRestrictionChecklist(restriction: Restriction) {
  return useApiQuery({
    path: '/maintenance-restrictions/{id}/release-checklist',
    request: { path: { id: restriction.id } },
  });
}

function itemCheck(item: ChecklistItem): Check {
  return {
    key: `item:${item.id}`,
    state: item.completedAt ? 'met' : 'unmet',
    label: item.label,
  };
}

type CheckState = 'met' | 'unmet' | 'warn' | 'none' | 'loading';

interface Check {
  key: string;
  state: CheckState;
  label: string;
}

const GLYPH: Record<CheckState, string> = {
  met: '✓',
  unmet: '✕',
  warn: '▲',
  none: '–',
  loading: '◷',
};

const STATE_TEXT: Record<CheckState, string> = {
  met: 'Done',
  unmet: 'Not yet',
  warn: 'Attention',
  none: 'Not applicable',
  loading: 'Checking',
};

function workCheck(task: Task | undefined, taskId: string | null, failed: boolean): Check {
  if (!taskId) return { key: 'work', state: 'none', label: 'No maintenance task is linked' };
  if (failed) return { key: 'work', state: 'warn', label: 'The linked task could not be read' };
  if (!task) return { key: 'work', state: 'loading', label: 'Work on the linked task' };
  return task.status === 'resolved' || task.status === 'closed'
    ? { key: 'work', state: 'met', label: `Work finished (task ${task.status})` }
    : { key: 'work', state: 'unmet', label: `Work not finished (task ${task.status})` };
}

function inspectionCheck(
  task: Task | undefined,
  restriction: Restriction,
  timezone: string,
): Check {
  if (!restriction.taskId || !task) {
    return restriction.taskId
      ? { key: 'inspection', state: 'loading', label: 'Inspection before release' }
      : { key: 'inspection', state: 'none', label: 'No inspection gate without a task' };
  }
  if (!task.requiresInspection) {
    return { key: 'inspection', state: 'met', label: 'No inspection required' };
  }
  const latest = task.latestInspection;
  if (!latest)
    return {
      key: 'inspection',
      state: 'unmet',
      label: 'A passed inspection is still needed (none recorded)',
    };
  if (latest.outcome !== 'passed') {
    return {
      key: 'inspection',
      state: 'unmet',
      label: `Last inspection ${latest.outcome} ${formatInstant(latest.inspectedAt, timezone)}`,
    };
  }
  if (
    task.status === 'in_progress' ||
    (restriction.approvedAt && Date.parse(latest.inspectedAt) < Date.parse(restriction.approvedAt))
  ) {
    return {
      key: 'inspection',
      state: 'unmet',
      label: 'The latest pass predates the current work or approval',
    };
  }
  return {
    key: 'inspection',
    state: 'met',
    label: `Inspection passed ${formatInstant(latest.inspectedAt, timezone)}`,
  };
}

/** The release checks for a restriction, from the task, its inspection, the closure and the role. */
export function useReleaseChecks(restriction: Restriction, facility: FacilityContext): Check[] {
  const task = useApiQuery({
    path: '/maintenance-tasks/{id}',
    request: { path: { id: restriction.taskId ?? '' } },
    enabled: restriction.taskId !== null,
  });
  const closure = useApiQuery({
    path: '/closures/{id}',
    request: { path: { id: restriction.schedulingClosureId ?? '' } },
    enabled: restriction.schedulingClosureId !== null,
  });
  const mayRelease = useActionAllowed('facilities.release_to_service', facility.id);
  const checklist = useRestrictionChecklist(restriction);
  const unresolved = closure.data?.resolution?.unresolvedEventIds.length ?? 0;
  const checks: Check[] = [
    workCheck(task.data, restriction.taskId, task.error !== null),
    inspectionCheck(task.data, restriction, facility.timezone),
    restriction.schedulingClosureId === null
      ? { key: 'bookings', state: 'none', label: 'No scheduling closure recorded' }
      : closure.data
        ? unresolved > 0
          ? {
              key: 'bookings',
              state: 'warn',
              label: `${unresolved} affected booking${unresolved === 1 ? '' : 's'} still need${unresolved === 1 ? 's' : ''} a resolution`,
            }
          : { key: 'bookings', state: 'met', label: 'No affected bookings await resolution' }
        : closure.error
          ? { key: 'bookings', state: 'warn', label: 'Booking impact could not be read' }
          : { key: 'bookings', state: 'loading', label: 'Affected bookings' },
    ...(checklist.data?.items ?? []).map(itemCheck),
    mayRelease
      ? { key: 'authority', state: 'met', label: 'You may release to service' }
      : { key: 'authority', state: 'unmet', label: 'Your role may not release to service' },
  ];
  return checks;
}

/** "assigned to Luis Ortega", from the checklist read; nothing while unknown. */
export function ownerLine(checklist: Checklist | undefined): string | null {
  const owner = checklist?.taskOwner;
  if (!owner) return null;
  return `assigned to ${owner.displayName ?? 'a staff member (name not available)'}`;
}

/**
 * Add, confirm, reopen and remove the restriction's own release checks (staff with
 * `facilities.manage_release_checklist`). Reopening and removing ask for the reason the API
 * records; every command carries the item's revision.
 */
export function ChecklistItemsEditor({
  restriction,
  facility,
}: {
  restriction: Restriction;
  facility: FacilityContext;
}) {
  const { online } = useApp();
  const allowed = useActionAllowed('facilities.manage_release_checklist', facility.id);
  const checklist = useRestrictionChecklist(restriction);
  const [label, setLabel] = useState('');
  const [reasonFor, setReasonFor] = useState<{ id: string; verb: 'reopen' | 'remove' } | null>(
    null,
  );
  const [reason, setReason] = useState('');
  const invalidate = [CHECKLIST_KEY] as const;
  const add = useApiCommand('post', '/maintenance-restrictions/{id}/checklist-items', {
    invalidate,
  });
  const complete = useApiCommand(
    'post',
    '/maintenance-restrictions/{id}/checklist-items/{itemId}/complete',
    { invalidate },
  );
  const reopen = useApiCommand(
    'post',
    '/maintenance-restrictions/{id}/checklist-items/{itemId}/reopen',
    { invalidate },
  );
  const remove = useApiCommand(
    'post',
    '/maintenance-restrictions/{id}/checklist-items/{itemId}/remove',
    { invalidate },
  );
  const open = ['proposed', 'approved', 'active'].includes(restriction.status);
  if (!allowed || !open || !checklist.data) return null;
  const items = checklist.data.items;
  const error = add.error ?? complete.error ?? reopen.error ?? remove.error;
  const path = (item: ChecklistItem) => ({ id: restriction.id, itemId: item.id });
  const submitReason = (item: ChecklistItem) => {
    if (!reasonFor || !reason.trim()) return;
    const command = reasonFor.verb === 'reopen' ? reopen : remove;
    void command
      .submit({
        path: path(item),
        body: { reason: reason.trim(), expectedRevision: item.revision },
      })
      .then(() => {
        setReasonFor(null);
        setReason('');
      })
      .catch(() => undefined);
  };
  return (
    <section className="checklist-editor" aria-label="Release checks for this restriction">
      <h5>Release checks</h5>
      {items.length === 0 ? (
        <p className="caption">No release checks yet. Add what must be confirmed before release.</p>
      ) : (
        <ul className="checklist-items">
          {items.map((item) => (
            <li key={item.id} data-state={item.completedAt ? 'met' : 'unmet'}>
              <span className="release-mark" aria-hidden="true">
                {item.completedAt ? '✓' : ''}
              </span>
              <span className="checklist-label">
                {item.label}
                {item.completedAt ? (
                  <span className="caption">
                    {' '}
                    confirmed by {item.completedBy?.actorLabel ?? 'staff'}
                    {item.completionNote ? `: ${item.completionNote}` : ''}
                  </span>
                ) : null}
              </span>
              <span className="actions-row">
                {item.completedAt ? (
                  <Button
                    variant="secondary"
                    className="button-sm"
                    disabled={!online}
                    onClick={() => setReasonFor({ id: item.id, verb: 'reopen' })}
                  >
                    Reopen
                  </Button>
                ) : (
                  <>
                    <Button
                      className="button-sm"
                      disabled={!online}
                      busy={complete.isProcessing}
                      aria-label={`Confirm: ${item.label}`}
                      onClick={() =>
                        void complete
                          .submit({
                            path: path(item),
                            body: { expectedRevision: item.revision },
                          })
                          .catch(() => undefined)
                      }
                    >
                      Confirm
                    </Button>
                    <Button
                      variant="secondary"
                      className="button-sm"
                      disabled={!online}
                      aria-label={`Remove: ${item.label}`}
                      onClick={() => setReasonFor({ id: item.id, verb: 'remove' })}
                    >
                      Remove
                    </Button>
                  </>
                )}
              </span>
              {reasonFor?.id === item.id ? (
                <form
                  className="checklist-reason"
                  onSubmit={(e) => {
                    e.preventDefault();
                    submitReason(item);
                  }}
                >
                  <label htmlFor={`reason-${item.id}`}>
                    Reason to {reasonFor.verb} “{item.label}”
                  </label>
                  <input
                    id={`reason-${item.id}`}
                    value={reason}
                    maxLength={2000}
                    onChange={(e) => setReason(e.target.value)}
                  />
                  <Button type="submit" className="button-sm" disabled={!online || !reason.trim()}>
                    {reasonFor.verb === 'reopen' ? 'Reopen check' : 'Remove check'}
                  </Button>
                </form>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <form
        className="checklist-add"
        onSubmit={(e) => {
          e.preventDefault();
          if (!label.trim()) return;
          void add
            .submit({ path: { id: restriction.id }, body: { label: label.trim() } })
            .then(() => setLabel(''))
            .catch(() => undefined);
        }}
      >
        <label htmlFor={`add-check-${restriction.id}`}>New release check</label>
        <input
          id={`add-check-${restriction.id}`}
          value={label}
          maxLength={200}
          placeholder="For example: net replaced and tensioned"
          onChange={(e) => setLabel(e.target.value)}
        />
        <Button
          type="submit"
          variant="secondary"
          className="button-sm"
          busy={add.isProcessing}
          disabled={!online || !label.trim()}
        >
          Add check
        </Button>
      </form>
      {!online ? <p className="caption">Changing release checks needs a connection.</p> : null}
      {error ? <CommandError error={error} action="Changing the release checks" /> : null}
    </section>
  );
}

function ChecklistView({ checks }: { checks: readonly Check[] }) {
  return (
    <ul className="release-checks" aria-label="Release to service checklist">
      {checks.map((c) => (
        <li key={c.key} data-state={c.state}>
          <span className="release-mark" aria-hidden="true">
            {GLYPH[c.state]}
          </span>
          <span>
            <span className="visually-hidden">{STATE_TEXT[c.state]}: </span>
            {c.label}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function ReleaseChecklist({
  restriction,
  facility,
}: {
  restriction: Restriction;
  facility: FacilityContext;
}) {
  return <ChecklistView checks={useReleaseChecks(restriction, facility)} />;
}

function RestrictionHero({
  restriction,
  facility,
  area,
}: {
  restriction: Restriction;
  facility: FacilityContext;
  area: string;
}) {
  const tz = facility.timezone;
  const checks = useReleaseChecks(restriction, facility);
  const owner = ownerLine(useRestrictionChecklist(restriction).data);
  // Highlighted only when nothing recorded stands in the way; the API still decides.
  const ready = checks.every((c) => c.state === 'met' || c.state === 'none' || c.state === 'warn');
  return (
    <section
      className="restriction-hero"
      aria-labelledby={`hero-${restriction.id}`}
      data-testid={`active-restriction-${restriction.id}`}
    >
      <div className="restriction-hero-inner">
        <span className="restriction-hero-icon" aria-hidden="true">
          <Icon name="construction" size={26} />
        </span>
        <div className="restriction-hero-text">
          <span className="restriction-hero-eyebrow">
            ▲ Active restriction · since {formatInstant(restriction.interval.start, tz)}
          </span>
          <h4 id={`hero-${restriction.id}`} className="restriction-hero-title">
            {area} · {restriction.reason}
          </h4>
          <span className="caption">
            {restriction.kind} until {formatInstant(restriction.interval.end, tz)}
            {restriction.taskId ? ' · linked to a maintenance task' : ''}
            {owner ? ` · ${owner}` : ''}
          </span>
        </div>
        <ChecklistView checks={checks} />
        <Link
          className={`button ${ready ? 'button-primary' : 'button-secondary'}`}
          to={`/facilities/restrictions/${restriction.id}`}
          aria-label={`Release ${area} to service: ${restriction.reason}`}
        >
          Release to service
        </Link>
      </div>
    </section>
  );
}

export function ActiveRestrictions({ facility }: { facility: FacilityContext }) {
  const restrictions = useApiQuery({
    path: '/maintenance-restrictions',
    request: { query: { facilityId: facility.id, status: 'active' } },
  });
  const { resourceNames } = useFacilityNames(facility.id);
  const active = (restrictions.data ?? []).filter((r) => r.status === 'active');
  if (!restrictions.data) return null;
  if (active.length === 0) {
    return (
      <p className="all-in-service" data-testid="no-active-restrictions">
        <span aria-hidden="true">✓</span> No active restrictions: every space is in service.
      </p>
    );
  }
  return (
    <div className="restriction-heroes" aria-label="Active restrictions" role="region">
      {active.map((r) => (
        <RestrictionHero
          key={r.id}
          restriction={r}
          facility={facility}
          area={resourceNames.get(r.resourceId) ?? 'An area'}
        />
      ))}
    </div>
  );
}
