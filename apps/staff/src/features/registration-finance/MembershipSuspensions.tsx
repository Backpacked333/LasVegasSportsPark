/**
 * Membership suspensions for staff (ENR-12, SPK-COND-001; Package G capability `memberships`,
 * DEC-016, DEC-072) on a membership enrollment (SCR-S-27): suspend for a period
 * (`POST /v1/enrollments/{id}/membership-suspensions`, start required, end optional, reason
 * required) and end a suspension (`POST /v1/membership-suspensions/{id}/end`, reason and the
 * suspension's `expectedRevision`), each with one idempotency key per intent. Times are entered
 * and shown in the offering facility's zone (SPK-SCHED-008).
 *
 * The API never turns suspensions off, so the panel sits under `CapabilityNotice`: the form always
 * renders, and the switch shows as a notice only once `GET /v1/me/permissions` says it is off.
 * Every suspension of the membership is listed, newest first, from
 * `GET /v1/enrollments/{id}/membership-suspensions` (GAPS-TRIAGE-02; authorized like the
 * suspension commands, "Load more" for older ones), with the id and revision ending one needs, so
 * a suspension recorded earlier (an open-ended one never ends by itself) can be ended from here.
 * The list is read again after a suspension is made or ended. Membership benefits and terms are
 * POL-038 and DEC-007; nothing is computed here.
 */
import type { Schema } from '@sportspark/api-client';
import { useState } from 'react';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiPages } from '../../api/useApiPages';
import { Button } from '../../ui/Button';
import { LoadMore } from '../../ui/LoadMore';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { StatusBadge } from '../../ui/StatusBadge';
import { CapabilityNotice } from './CapabilityNotice';
import { CommandError, fieldErrorsOf } from './CommandError';
import { TextArea, TextField } from './fields';
import { formatInstant, localToInstant } from './format';
import { SUSPENSION_STATUS } from './labels';
import { OfflineCaption, useOnline } from './offline';

type Suspension = Schema<'MembershipSuspension'>;
type Enrollment = Schema<'Enrollment'>;

/** Invalidated after a suspension is made or ended, so the list shows the server's answer. */
const SUSPENSIONS_KEY = ['api', '/enrollments/{id}/membership-suspensions'] as const;

function zoneLabel(zone: string | null): string {
  return zone ? `facility time, ${zone}` : 'UTC: the facility time zone is not available';
}

function EndSuspension({
  suspension,
  zone,
  onEnded,
}: {
  suspension: Suspension;
  zone: string | null;
  onEnded: (ended: Suspension) => void;
}) {
  const online = useOnline();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | null>(null);
  const end = useApiCommand('post', '/membership-suspensions/{id}/end', {
    invalidate: [SUSPENSIONS_KEY],
  });
  const label = `the suspension from ${formatInstant(suspension.from, zone)}`;
  if (suspension.status !== 'active') return null;
  if (!open) {
    return (
      <Button
        variant="secondary"
        disabled={!online}
        aria-label={`End ${label}`}
        onClick={() => setOpen(true)}
      >
        End suspension…
      </Button>
    );
  }
  return (
    <form
      noValidate
      aria-label={`End ${label}`}
      onSubmit={(event) => {
        event.preventDefault();
        if (!reason.trim()) {
          setReasonError('A reason is required and is audited.');
          return;
        }
        setReasonError(null);
        end
          .submit({
            path: { id: suspension.id },
            body: { reason: reason.trim(), expectedRevision: suspension.revision },
          })
          .then((ended) => {
            setOpen(false);
            onEnded(ended);
          })
          .catch(() => undefined);
      }}
    >
      <TextArea
        label="Reason for ending the suspension"
        required
        value={reason}
        onChange={setReason}
        error={reasonError}
      />
      <div className="rf-actions">
        <Button type="submit" busy={end.isProcessing} disabled={!online || end.isProcessing}>
          End the suspension
        </Button>
        <Button variant="secondary" onClick={() => setOpen(false)}>
          Keep it
        </Button>
      </div>
      <CommandError error={end.error} />
    </form>
  );
}

function SuspendForm({
  enrollment,
  zone,
  onSuspended,
}: {
  enrollment: Enrollment;
  zone: string | null;
  onSuspended: (s: Suspension) => void;
}) {
  const online = useOnline();
  const [from, setFrom] = useState('');
  const [until, setUntil] = useState('');
  const [reason, setReason] = useState('');
  const [local, setLocal] = useState<Record<string, string>>({});
  const suspend = useApiCommand('post', '/enrollments/{id}/membership-suspensions', {
    invalidate: [SUSPENSIONS_KEY],
  });
  const server = fieldErrorsOf(suspend.error);
  return (
    <form
      noValidate
      aria-label="Suspend the membership"
      onSubmit={(event) => {
        event.preventDefault();
        const errors: Record<string, string> = {};
        const fromAt = localToInstant(from, zone);
        const untilAt = until.trim() ? localToInstant(until, zone) : null;
        if (!fromAt) errors.from = 'Enter when the suspension starts.';
        if (until.trim() && !untilAt) errors.until = 'Enter a valid end, or leave it empty.';
        if (fromAt && untilAt && untilAt <= fromAt)
          errors.until = 'A suspension ends after it starts.';
        if (!reason.trim()) errors.reason = 'A reason is required and is audited.';
        setLocal(errors);
        if (Object.keys(errors).length > 0 || !fromAt) return;
        suspend
          .submit({
            path: { id: enrollment.id },
            body: {
              from: fromAt,
              ...(untilAt ? { until: untilAt } : {}),
              reason: reason.trim(),
            },
          })
          .then((created) => {
            onSuspended(created);
            setFrom('');
            setUntil('');
            setReason('');
          })
          .catch(() => undefined);
      }}
    >
      <div className="rf-grid">
        <TextField
          label={`Suspended from (${zoneLabel(zone)})`}
          type="datetime-local"
          required
          value={from}
          onChange={setFrom}
          error={local.from ?? server.from}
        />
        <TextField
          label={`Suspended until (${zoneLabel(zone)})`}
          type="datetime-local"
          hint="Leave empty to suspend until the suspension is ended."
          value={until}
          onChange={setUntil}
          error={local.until ?? server.until}
        />
      </div>
      <TextArea
        label="Reason for the suspension"
        required
        value={reason}
        onChange={setReason}
        error={local.reason ?? server.reason}
      />
      <div className="rf-actions">
        <Button
          type="submit"
          busy={suspend.isProcessing}
          disabled={!online || suspend.isProcessing}
        >
          Suspend the membership
        </Button>
      </div>
      <OfflineCaption action="suspending a membership" />
      <CommandError error={suspend.error} />
    </form>
  );
}

function SuspensionRow({
  suspension,
  zone,
  onEnded,
}: {
  suspension: Suspension;
  zone: string | null;
  onEnded: (ended: Suspension) => void;
}) {
  return (
    <li>
      <div className="row-text">
        <span>
          <StatusBadge {...SUSPENSION_STATUS[suspension.status]} />{' '}
          {formatInstant(suspension.from, zone)} to{' '}
          {suspension.until ? formatInstant(suspension.until, zone) : 'until ended'}
        </span>
        <span className="caption">
          {suspension.reason}
          {suspension.endedAt
            ? ` · ended ${formatInstant(suspension.endedAt, zone)}${suspension.endedReason ? `: ${suspension.endedReason}` : ''}`
            : ''}
        </span>
      </div>
      <EndSuspension suspension={suspension} zone={zone} onEnded={onEnded} />
    </li>
  );
}

export function MembershipSuspensionPanel({
  enrollment,
  zone,
}: {
  enrollment: Enrollment;
  zone: string | null;
}) {
  const suspensions = useApiPages({
    path: '/enrollments/{id}/membership-suspensions',
    request: { path: { id: enrollment.id } },
  });
  /** Answers of commands made here, shown at once until the list is read again. */
  const [answered, setAnswered] = useState<Suspension[]>([]);
  const remember = (next: Suspension) =>
    setAnswered((list) => [next, ...list.filter((s) => s.id !== next.id)]);
  const merged = (listed: readonly Suspension[]): Suspension[] => {
    const newer = (s: Suspension) => {
      const mine = answered.find((a) => a.id === s.id);
      return mine && mine.revision > s.revision ? mine : s;
    };
    const known = new Set(listed.map((s) => s.id));
    return [...answered.filter((a) => !known.has(a.id)), ...listed.map(newer)];
  };
  return (
    <section className="rf-panel" aria-labelledby="suspensions-title">
      <h3 id="suspensions-title">Membership suspensions</h3>
      <CapabilityNotice
        capability="memberships"
        stillAvailable="Suspending a membership and ending a suspension stay available: they are never turned off."
      >
        <p className="caption">
          While a suspension is active, booking a session with this membership is refused
          (MEMBERSHIP_SUSPENDED).
        </p>
        {enrollment.status === 'confirmed' ? (
          <SuspendForm enrollment={enrollment} zone={zone} onSuspended={remember} />
        ) : (
          <p>Only a confirmed membership can be suspended.</p>
        )}
        <QueryBoundary
          query={suspensions}
          label="suspensions"
          isEmpty={(items) => merged(items).length === 0}
          empty={{ title: 'No suspensions', description: 'This membership was never suspended.' }}
        >
          {(items) => (
            <ul className="list" aria-label="Suspensions of this membership">
              {merged(items).map((s) => (
                <SuspensionRow key={s.id} suspension={s} zone={zone} onEnded={remember} />
              ))}
            </ul>
          )}
        </QueryBoundary>
        {suspensions.data === undefined && answered.length > 0 ? (
          // The list could not be read (yet): what was done here is still shown and can be ended.
          <ul className="list" aria-label="Suspensions recorded here">
            {answered.map((s) => (
              <SuspensionRow key={s.id} suspension={s} zone={zone} onEnded={remember} />
            ))}
          </ul>
        ) : null}
        <LoadMore pages={suspensions} label="suspensions" />
      </CapabilityNotice>
    </section>
  );
}
