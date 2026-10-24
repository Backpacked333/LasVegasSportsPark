/**
 * SCR-W-02 Assignment offer and response, and SCR-W-03 Activity detail for staff (SPK-UX-007,
 * SPK-STAFF-002, SPK-STAFF-003, SPK-AT-012, SPK-COMP-005, SPK-READY-001 to SPK-READY-004,
 * SPK-COMMS-005), usable on a phone beside a field.
 *
 * - Accept, decline (optional reason) and withdraw (reason required) appear only when the API
 *   lists them in `availableActions`; each sends the expected revision and its own idempotency
 *   key. An overlap with another accepted assignment is the API's refusal, shown with its code.
 *   Offline, responding is disabled and the offer stays visible with its age.
 * - Activity detail shows only what the workspace may see: time, role, team names, and for a
 *   fixture the readiness explanation (`GET /v1/fixtures/{id}/readiness`: checks, issues with
 *   the responsible role and required action, and roster counts per side, never player personal
 *   details). Material changes come from the viewer's notices about this activity, old and new.
 * - The API gives no respond-by deadline on an offer and no field-limited player list, so neither
 *   is shown.
 */
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { activityFromAssignment } from '../../features/operations/activity';
import { CommandError, CommandSuccess } from '../../features/operations/feedback';
import { TextAreaField, fieldErrorsOf } from '../../features/operations/fields';
import { formatInstant, formatRange, humanize } from '../../features/operations/format';
import { FEE_STATUS } from '../../features/operations/labels';
import { useApp } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { StateView } from '../../ui/StateView';
import { StatusBadge, type StatusTone } from '../../ui/StatusBadge';
import { MY_ASSIGNMENTS_KEY, MyAssignmentPage, type WorkspaceAssignment } from './MyAssignment';
import { ASSIGNMENT_BADGE } from './WorkspaceScreen';

export function AssignmentWorkspaceScreen() {
  return (
    <MyAssignmentPage
      title={(item) => item?.activity.title ?? 'Assignment'}
      unavailableOffline={['accepting, declining and withdrawing']}
    >
      {(item) => (
        <>
          <OfferAndResponse item={item} />
          <ActivityDetail item={item} />
          <WorkspaceLinks item={item} />
        </>
      )}
    </MyAssignmentPage>
  );
}

function OfferAndResponse({ item }: { item: WorkspaceAssignment }) {
  const { online } = useApp();
  const queryClient = useQueryClient();
  const a = item.assignment;
  const invalidate = [MY_ASSIGNMENTS_KEY];
  const accept = useApiCommand('post', '/assignments/{id}/accept', { invalidate });
  const decline = useApiCommand('post', '/assignments/{id}/decline', { invalidate });
  const withdraw = useApiCommand('post', '/assignments/{id}/withdraw', { invalidate });
  const [mode, setMode] = useState<'decline' | 'withdraw' | null>(null);
  const [reason, setReason] = useState('');
  const [missing, setMissing] = useState(false);
  const badge = ASSIGNMENT_BADGE[a.status];
  const can = (action: string) => item.availableActions.includes(action);
  const path = { id: a.id };
  const error = accept.error ?? decline.error ?? withdraw.error;
  const reload = () => {
    accept.reset();
    decline.reset();
    withdraw.reset();
    void queryClient.invalidateQueries({ queryKey: MY_ASSIGNMENTS_KEY });
  };
  const confirm = () => {
    if (mode === 'withdraw' && !reason.trim()) {
      setMissing(true);
      return;
    }
    setMissing(false);
    const body = {
      expectedRevision: a.revision,
      ...(reason.trim() ? { reason: reason.trim() } : {}),
    };
    if (mode === 'decline') void decline.submit({ path, body }).catch(() => undefined);
    if (mode === 'withdraw') {
      void withdraw
        .submit({ path, body: { ...body, reason: reason.trim() } })
        .catch(() => undefined);
    }
  };
  const outcome = accept.data ?? decline.data ?? withdraw.data;
  return (
    <section className="ops-section" aria-labelledby="offer-title">
      <h3 id="offer-title">
        {humanize(a.role)}
        {a.slot > 1 ? `, slot ${a.slot}` : ''}
      </h3>
      <StatusBadge tone={badge.tone} label={badge.label} />
      <p>{formatRange(a.scheduledStart, a.scheduledEnd)}</p>
      <p className="caption">
        You are held until {formatInstant(a.committedUntil)} including {a.turnaroundMinutes} minutes
        of turnaround.
        {a.engagement !== 'regular'
          ? ` ${humanize(a.engagement)} work: your access ${a.access.until ? `ends ${formatInstant(a.access.until)}` : 'is time-bounded'}.`
          : ''}
      </p>
      {a.declineReason ? <p className="caption">Declined: {a.declineReason}</p> : null}
      {a.withdrawnReason ? <p className="caption">Withdrawn: {a.withdrawnReason}</p> : null}
      {online ? (
        <div className="ops-actions">
          {can('accept') ? (
            <Button
              busy={accept.isProcessing}
              onClick={() =>
                void accept
                  .submit({ path, body: { expectedRevision: a.revision } })
                  .catch(() => undefined)
              }
            >
              Accept
            </Button>
          ) : null}
          {can('decline') ? (
            <Button variant="secondary" onClick={() => setMode('decline')}>
              Decline
            </Button>
          ) : null}
          {can('withdraw') ? (
            <Button variant="secondary" onClick={() => setMode('withdraw')}>
              Withdraw
            </Button>
          ) : null}
        </div>
      ) : item.availableActions.some((x) => ['accept', 'decline', 'withdraw'].includes(x)) ? (
        <p className="caption">Responding needs a connection. The offer stays here.</p>
      ) : null}
      {mode && online ? (
        <form
          className="ops-form"
          aria-label={mode === 'decline' ? 'Decline this offer' : 'Withdraw from this assignment'}
          onSubmit={(event) => {
            event.preventDefault();
            confirm();
          }}
        >
          <TextAreaField
            label={mode === 'decline' ? 'Reason (optional)' : 'Reason for withdrawing'}
            value={reason}
            onChange={setReason}
            required={mode === 'withdraw'}
            hint={
              mode === 'withdraw' ? 'The organiser is told so the slot can be covered.' : undefined
            }
            error={missing ? 'A reason is required.' : fieldErrorsOf(withdraw.error).reason}
          />
          <div className="ops-actions">
            <Button type="submit" busy={decline.isProcessing || withdraw.isProcessing}>
              {mode === 'decline' ? 'Confirm decline' : 'Confirm withdrawal'}
            </Button>
            <Button variant="secondary" onClick={() => setMode(null)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : null}
      {error ? <CommandError error={error} onReload={reload} subject="This assignment" /> : null}
      {outcome ? (
        <CommandSuccess label={ASSIGNMENT_BADGE[outcome.assignment.status].label} />
      ) : null}
    </section>
  );
}

const READINESS_TONE: Record<'ready' | 'warning' | 'unknown' | 'blocked', StatusTone> = {
  ready: 'success',
  warning: 'warning',
  unknown: 'neutral',
  blocked: 'danger',
};

function ActivityDetail({ item }: { item: WorkspaceAssignment }) {
  const a = item.assignment;
  const isFixture = item.activity.targetType === 'fixture';
  const readiness = useApiQuery({
    path: '/fixtures/{id}/readiness',
    request: { path: { id: item.activity.targetId } },
    enabled: isFixture,
  });
  const inbox = useApiQuery({ path: '/me/inbox', request: { query: { limit: 50 } } });
  const ids = new Set([item.activity.targetId, a.schedulingEventId].filter(Boolean));
  const changes = (inbox.data?.items ?? []).filter(
    (n) => n.subject && ids.has(n.subject.id) && (n.detailsBefore || n.detailsAfter),
  );
  return (
    <section className="ops-section" aria-labelledby="activity-title">
      <h3 id="activity-title">Activity</h3>
      {item.activity.participants.length > 0 ? (
        <p>
          {item.activity.participants
            .map((p) => `${p.name}${p.side ? ` (${p.side})` : ''}`)
            .join(' v ')}
        </p>
      ) : null}
      {isFixture ? (
        <QueryBoundary
          query={readiness}
          label="readiness"
          agePrefix="Readiness as of"
          empty={{ title: '', description: '' }}
        >
          {(r) => (
            <div>
              <StatusBadge
                tone={READINESS_TONE[r.status]}
                label={`Readiness: ${humanize(r.status)}`}
              />
              <p className="caption">Evaluated {formatInstant(r.evaluatedAt)}.</p>
              <ul className="ops-history" aria-label="Readiness checks">
                {r.checks.map((c) => (
                  <li key={c.name}>
                    <StatusBadge
                      tone={READINESS_TONE[c.status]}
                      label={`${humanize(c.name)}: ${humanize(c.status)}`}
                    />
                    {c.issueCount > 0 ? ` (${c.issueCount})` : ''}
                  </li>
                ))}
              </ul>
              {r.issues.length > 0 ? (
                <ul className="ops-history" aria-label="Readiness issues">
                  {r.issues.map((issue) => (
                    <li key={`${issue.code}-${issue.source.id ?? ''}`}>
                      {issue.message}{' '}
                      <span className="caption">
                        ({humanize(issue.responsibleRole)}: {humanize(issue.requiredAction)})
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
              <ul className="ops-history" aria-label="Sides">
                {r.sides.map((s) => (
                  <li key={s.teamEntryId}>
                    {s.teamName}: {s.eligiblePlayers} eligible of {s.rosterSize} on the roster
                    {s.unknownPlayers > 0
                      ? `, ${s.unknownPlayers} not yet known`
                      : ''} (minimum {s.minimumPlayers})
                  </li>
                ))}
              </ul>
            </div>
          )}
        </QueryBoundary>
      ) : null}
      {changes.length > 0 ? (
        <div>
          <h4>Changes to this activity</h4>
          <ul className="ops-history" aria-label="Changes to this activity">
            {changes.map((n) => (
              <li key={n.attemptId}>
                {n.title}: was {summaryOf(n.detailsBefore)}, now {summaryOf(n.detailsAfter)}
                {n.supersededByNotificationId ? ' (replaced by a newer update)' : ''}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {item.fee ? (
        <p>
          Fee:{' '}
          <StatusBadge
            tone={FEE_STATUS[item.fee.status].tone}
            label={FEE_STATUS[item.fee.status].label}
          />
        </p>
      ) : null}
    </section>
  );
}

function summaryOf(details: Record<string, unknown> | null): string {
  if (!details) return 'not stated';
  const summary = details.summary;
  if (typeof summary === 'string') return summary;
  return Object.entries(details)
    .map(
      ([k, v]) =>
        `${humanize(k)} ${typeof v === 'string' || typeof v === 'number' ? v : JSON.stringify(v)}`,
    )
    .join(', ');
}

/** Navigation to the other workspace screens for this assignment; each screen asks the API. */
function WorkspaceLinks({ item }: { item: WorkspaceAssignment }) {
  const a = item.assignment;
  const base = `/workspace/assignments/${a.id}`;
  const working = a.status === 'accepted' || a.status === 'completed';
  const activity = activityFromAssignment(a);
  return (
    <nav className="ops-section" aria-label="For this assignment">
      <h3>For this assignment</h3>
      {!working ? (
        <StateView
          variant="empty"
          title="Nothing to record yet"
          description="Attendance, match reports and release open once you have accepted the assignment."
        />
      ) : (
        <ul className="ops-history">
          {activity ? (
            <li>
              <Link to={`${base}/attendance`}>Record attendance</Link>
            </li>
          ) : null}
          {a.targetType === 'fixture' && a.kind === 'official' ? (
            <li>
              <Link to={`${base}/report`}>Match report</Link>
            </li>
          ) : null}
          {a.targetType === 'session' && a.kind === 'coach' ? (
            <li>
              <Link to={`${base}/release`}>Supervised release</Link>
            </li>
          ) : null}
          <li>
            <Link to={`${base}/message`}>Message participants</Link>
          </li>
          {item.availableActions.includes('submit_fee') || item.fee ? (
            <li>
              <Link to="/workspace/fees">Hours and fees</Link>
            </li>
          ) : null}
        </ul>
      )}
    </nav>
  );
}
