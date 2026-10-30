/**
 * SCR-S-33 Assignment management and replacement, one assignment (SPK-STAFF-002 to
 * SPK-STAFF-004, SPK-AT-012).
 *
 * - The record with its history (offered, responded, declined with reason, withdrawn with
 *   reason, completed) and its time-bounded access (SPK-STAFF-004).
 * - Transitions are offered only where the API lists them for the viewer now
 *   (`availableActions` of the staff list `GET /v1/assignments?targetType&targetId`, WRK-01: the
 *   machine events allowed from the current state that the viewer's roles may perform at the
 *   assignment's facility); accept and decline belong to the assignee (SCR-W-02). Each sends the
 *   expected revision; STALE_REVISION or INVALID_TRANSITION (the official responded concurrently)
 *   reloads the record.
 * - Replacement (`GET`/`POST /v1/assignments/{id}/replacements`): qualified, available,
 *   non-conflicting candidates with the API's reasons; offering the slot to one, optionally
 *   withdrawing the original (absent official). A slot left uncovered close to kickoff is
 *   escalated by the API and shown.
 */
import type { Schema } from '@sportspark/api-client';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { AreaTabs, STAFF_TABS } from '../../features/operations/AreaTabs';
import { nameOf, useFacilityZone, usePersonNames } from '../../features/operations/context';
import { CommandError, CommandSuccess } from '../../features/operations/feedback';
import {
  CheckboxField,
  SelectField,
  TextAreaField,
  fieldErrorsOf,
} from '../../features/operations/fields';
import { formatInstant, formatRange, humanize } from '../../features/operations/format';
import { ASSIGNMENT_STATUS } from '../../features/operations/labels';
import { Button } from '../../ui/Button';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { StateView } from '../../ui/StateView';
import { StatusBadge, type StatusTone } from '../../ui/StatusBadge';
import { UncoveredNotice } from './AssignmentsScreen';

type Assignment = Schema<'Assignment'>;
type AssignmentStatus = Schema<'AssignmentStatus'>;

/** The staff transitions this screen offers, when the API lists them in `availableActions`. */
const STAFF_EVENTS = ['offer', 'complete', 'withdraw'] as const;
type StaffEvent = (typeof STAFF_EVENTS)[number];
/** States from which the slot may need someone else (the original stays in history). */
const REPLACEABLE: ReadonlySet<AssignmentStatus> = new Set([
  'offered',
  'accepted',
  'declined',
  'withdrawn',
]);

export function AssignmentDetailScreen() {
  const { assignmentId = '' } = useParams();
  const assignment = useApiQuery({
    path: '/assignments/{id}',
    request: { path: { id: assignmentId } },
  });
  return (
    <section aria-labelledby="assignment-title">
      <h2 id="assignment-title">Assignment</h2>
      <AreaTabs label="Staff and officials screens" tabs={STAFF_TABS} />
      <p>
        <Link to="/staff">All assignments</Link>
      </p>
      <QueryBoundary
        query={assignment}
        label="the assignment"
        empty={{ title: '', description: '' }}
        unavailableOffline={['offering, withdrawing and replacing assignments']}
      >
        {(a) => <AssignmentDetail assignment={a} />}
      </QueryBoundary>
    </section>
  );
}

function AssignmentDetail({ assignment: a }: { assignment: Assignment }) {
  // SPK-SCHED-008: the assignment's facility zone.
  const zone = useFacilityZone(a.facilityId);
  const names = usePersonNames([a.personId]);
  const badge = ASSIGNMENT_STATUS[a.status];
  const access = a.access;
  return (
    <>
      <div className="ops-section">
        <h3>
          {a.targetTitle}: {humanize(a.role)}
          {a.slot > 1 ? ` (slot ${a.slot})` : ''}
        </h3>
        <StatusBadge tone={badge.tone} label={badge.label} />
        <dl>
          <dt>Person</dt>
          <dd>{nameOf(names, a.personId)}</dd>
          <dt>When</dt>
          <dd>{formatRange(a.scheduledStart, a.scheduledEnd, zone)}</dd>
          <dt>Held until (with turnaround of {a.turnaroundMinutes} minutes)</dt>
          <dd>{formatInstant(a.committedUntil, zone)}</dd>
          <dt>Engagement</dt>
          <dd>{humanize(a.engagement)}</dd>
          <dt>Time-bounded access</dt>
          <dd>
            {humanize(access.status)}
            {access.from && access.until
              ? `, ${formatInstant(access.from, zone)} to ${formatInstant(access.until, zone)}`
              : ''}
            {access.active ? ' (in effect now)' : ''}
          </dd>
        </dl>
        <ol className="ops-history" aria-label="Assignment history">
          {a.offeredAt ? <li>Offered {formatInstant(a.offeredAt, zone)}</li> : null}
          {a.acceptedAt ? <li>Accepted {formatInstant(a.acceptedAt, zone)}</li> : null}
          {a.declinedAt ? (
            <li>
              Declined {formatInstant(a.declinedAt, zone)}
              {a.declineReason ? `: ${a.declineReason}` : ''}
            </li>
          ) : null}
          {a.withdrawnAt ? (
            <li>
              Withdrawn {formatInstant(a.withdrawnAt, zone)}
              {a.withdrawnReason ? `: ${a.withdrawnReason}` : ''}
            </li>
          ) : null}
          {a.completedAt ? <li>Completed {formatInstant(a.completedAt, zone)}</li> : null}
          {a.replacesAssignmentId ? (
            <li>
              Replaces{' '}
              <Link to={`/staff/assignments/${a.replacesAssignmentId}`}>an earlier assignment</Link>
            </li>
          ) : null}
        </ol>
      </div>
      <Transitions assignment={a} />
      {REPLACEABLE.has(a.status) ? <Replacement assignment={a} /> : null}
    </>
  );
}

/** WRK-01: the events the viewer may perform on this assignment now, from the staff list. */
function useAvailableActions(a: Assignment) {
  const list = useApiQuery({
    path: '/assignments',
    request: { query: { targetType: a.targetType, targetId: a.targetId, limit: 50 } },
  });
  const item = list.data?.items.find((i) => i.id === a.id);
  return {
    list,
    events: item
      ? STAFF_EVENTS.filter((e) => item.availableActions.includes(e))
      : list.data
        ? []
        : undefined,
  };
}

function Transitions({ assignment: a }: { assignment: Assignment }) {
  const zone = useFacilityZone(a.facilityId);
  const queryClient = useQueryClient();
  const available = useAvailableActions(a);
  const invalidate = [
    ['api', '/assignments/{id}'],
    ['api', '/assignments'],
  ] as const;
  const offer = useApiCommand('post', '/assignments/{id}/offer', { invalidate });
  const complete = useApiCommand('post', '/assignments/{id}/complete', { invalidate });
  const withdraw = useApiCommand('post', '/assignments/{id}/withdraw', { invalidate });
  const [withdrawing, setWithdrawing] = useState(false);
  const [reason, setReason] = useState('');
  const [missingReason, setMissingReason] = useState(false);
  const allowed: readonly StaffEvent[] = available.events ?? [];
  const reload = () => {
    offer.reset();
    complete.reset();
    withdraw.reset();
    void queryClient.invalidateQueries({ queryKey: ['api', '/assignments/{id}'] });
    void queryClient.invalidateQueries({ queryKey: ['api', '/assignments'] });
  };
  if (available.events === undefined) {
    return (
      <section className="ops-section" aria-labelledby="transitions-title">
        <h3 id="transitions-title">Change this assignment</h3>
        {available.list.error ? (
          <StateView
            variant="error"
            error={available.list.error}
            onRetry={() => void available.list.refetch()}
          />
        ) : (
          <StateView variant="loading" label="what you may change" />
        )}
      </section>
    );
  }
  const last = offer.data ?? complete.data ?? withdraw.data;
  if (allowed.length === 0 && !last) return null;
  const path = { id: a.id };
  const body = { expectedRevision: a.revision };
  const error = offer.error ?? complete.error ?? withdraw.error;
  const submitWithdraw = () => {
    if (!reason.trim()) {
      setMissingReason(true);
      return;
    }
    setMissingReason(false);
    void withdraw.submit({ path, body: { ...body, reason: reason.trim() } }).catch(() => undefined);
  };
  return (
    <section className="ops-section" aria-labelledby="transitions-title">
      <h3 id="transitions-title">Change this assignment</h3>
      <div className="ops-actions">
        {allowed.includes('offer') ? (
          <Button
            busy={offer.isProcessing}
            onClick={() => void offer.submit({ path, body }).catch(() => undefined)}
          >
            Offer to the person
          </Button>
        ) : null}
        {allowed.includes('complete') ? (
          <Button
            variant="secondary"
            busy={complete.isProcessing}
            onClick={() => void complete.submit({ path, body }).catch(() => undefined)}
          >
            Mark completed
          </Button>
        ) : null}
        {allowed.includes('withdraw') ? (
          <Button
            variant="secondary"
            onClick={() => setWithdrawing((w) => !w)}
            aria-expanded={withdrawing}
          >
            Withdraw
          </Button>
        ) : null}
      </div>
      {withdrawing ? (
        <form
          className="ops-form"
          aria-label="Withdraw this assignment"
          onSubmit={(event) => {
            event.preventDefault();
            submitWithdraw();
          }}
        >
          <TextAreaField
            label="Reason for withdrawing"
            value={reason}
            onChange={setReason}
            required
            error={missingReason ? 'A reason is required.' : fieldErrorsOf(withdraw.error).reason}
          />
          <Button type="submit" busy={withdraw.isProcessing}>
            Confirm withdrawal
          </Button>
        </form>
      ) : null}
      {error ? <CommandError error={error} onReload={reload} subject="This assignment" /> : null}
      {last ? (
        <CommandSuccess label={ASSIGNMENT_STATUS[last.assignment.status].label}>
          {last.uncovered ? <UncoveredNotice notice={last.uncovered} timezone={zone} /> : null}
        </CommandSuccess>
      ) : null}
    </section>
  );
}

const REASON_TONE: Record<Schema<'ReplacementCandidateReason'>['severity'], StatusTone> = {
  blocking: 'danger',
  warning: 'warning',
  info: 'info',
  positive: 'success',
};

function Replacement({ assignment: a }: { assignment: Assignment }) {
  const zone = useFacilityZone(a.facilityId);
  const candidates = useApiQuery({
    path: '/assignments/{id}/replacements',
    request: { path: { id: a.id } },
  });
  const command = useApiCommand('post', '/assignments/{id}/replacements', {
    invalidate: [
      ['api', '/assignments/{id}'],
      ['api', '/assignments'],
      ['api', '/assignments/{id}/replacements'],
    ],
  });
  const [personId, setPersonId] = useState('');
  const [reason, setReason] = useState('');
  const [withdrawOriginal, setWithdrawOriginal] = useState(
    a.status === 'accepted' || a.status === 'offered',
  );
  const [offerNow, setOfferNow] = useState(true);
  const [engagement, setEngagement] = useState<Assignment['engagement']>('substitute');
  const [problems, setProblems] = useState<Record<string, string>>({});
  const canWithdraw = a.status === 'accepted' || a.status === 'offered';

  const submit = () => {
    const next: Record<string, string> = {};
    if (!personId) next.personId = 'Choose an eligible replacement.';
    if (!reason.trim()) next.reason = 'A reason is required.';
    setProblems(next);
    if (Object.keys(next).length > 0) return;
    void command
      .submit({
        path: { id: a.id },
        body: {
          personId,
          engagement,
          offer: offerNow,
          withdrawOriginal: canWithdraw && withdrawOriginal,
          reason: reason.trim(),
          expectedRevision: a.revision,
        },
      })
      .catch(() => undefined);
  };

  return (
    <section className="ops-section" aria-labelledby="replacement-title">
      <h3 id="replacement-title">Find a replacement</h3>
      <QueryBoundary
        query={candidates}
        label="replacement candidates"
        isEmpty={(data) => data.candidates.length === 0}
        empty={{
          title: 'No candidates',
          description:
            'Nobody holds the required qualifications and is free at this time. The slot stays uncovered until someone is assigned.',
        }}
        unavailableOffline={['offering the slot to a replacement']}
      >
        {(data) => (
          <form
            className="ops-form"
            aria-label="Offer the slot to a replacement"
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            {data.requiredQualifications.length > 0 ? (
              <p className="caption">
                Requires: {data.requiredQualifications.map(humanize).join(', ')}.
              </p>
            ) : null}
            <fieldset className="ops-fieldset">
              <legend>Candidates (evaluated {formatInstant(data.evaluatedAt, zone)})</legend>
              {data.candidates.map((c) => (
                <div key={c.personId}>
                  <label className="ops-check">
                    <input
                      type="radio"
                      name="replacement"
                      value={c.personId}
                      disabled={!c.eligible}
                      checked={personId === c.personId}
                      onChange={() => setPersonId(c.personId)}
                    />
                    {c.displayName}{' '}
                    <StatusBadge
                      tone={c.eligible ? 'success' : 'neutral'}
                      label={c.eligible ? 'Eligible' : 'Not eligible'}
                    />
                  </label>
                  <ul className="ops-history" aria-label={`Reasons for ${c.displayName}`}>
                    {c.reasons.map((r) => (
                      <li key={`${r.code}-${r.sourceIds.join(',')}`}>
                        <StatusBadge tone={REASON_TONE[r.severity]} label={humanize(r.severity)} />{' '}
                        {r.message}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </fieldset>
            {problems.personId ? (
              <p className="error-text" role="alert">
                <span aria-hidden="true">✕ </span>
                {problems.personId}
              </p>
            ) : null}
            <SelectField
              label="Engagement of the replacement"
              value={engagement}
              onChange={(v) => setEngagement(v as Assignment['engagement'])}
              options={['substitute', 'temporary', 'regular'].map((v) => ({
                value: v,
                label: humanize(v),
              }))}
            />
            <CheckboxField
              label="Offer it to the replacement now"
              checked={offerNow}
              onChange={setOfferNow}
            />
            {canWithdraw ? (
              <CheckboxField
                label="Withdraw the original assignment (absent official)"
                checked={withdrawOriginal}
                onChange={setWithdrawOriginal}
              />
            ) : null}
            <TextAreaField
              label="Reason for the replacement"
              value={reason}
              onChange={setReason}
              required
              error={problems.reason ?? fieldErrorsOf(command.error).reason}
            />
            <Button type="submit" busy={command.isProcessing}>
              Offer the slot
            </Button>
          </form>
        )}
      </QueryBoundary>
      {command.error ? (
        <CommandError error={command.error} onRetry={submit} subject="This assignment" />
      ) : null}
      {command.data ? (
        <CommandSuccess
          label={`Replacement ${ASSIGNMENT_STATUS[command.data.replacement.status].label.toLowerCase()}`}
        >
          <Link to={`/staff/assignments/${command.data.replacement.id}`}>Open the replacement</Link>
          <span className="caption">
            Original: {ASSIGNMENT_STATUS[command.data.original.status].label}. Readiness is
            re-evaluated by the service.
          </span>
          {command.data.uncovered ? (
            <UncoveredNotice notice={command.data.uncovered} timezone={zone} />
          ) : null}
        </CommandSuccess>
      ) : null}
    </section>
  );
}
