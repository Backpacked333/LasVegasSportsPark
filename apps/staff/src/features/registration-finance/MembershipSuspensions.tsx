/**
 * Membership suspensions for staff (ENR-12, SPK-COND-001; Package G capability `memberships`,
 * DEC-016, DEC-072) on a membership enrollment (SCR-S-27): suspend for a period
 * (`POST /v1/enrollments/{id}/membership-suspensions`, start required, end optional, reason
 * required) and end a suspension (`POST /v1/membership-suspensions/{id}/end`, reason and the
 * suspension's `expectedRevision`), each with one idempotency key per intent. Times are entered
 * and shown in the offering facility's zone (SPK-SCHED-008).
 *
 * The API never turns suspensions off, so the panel sits under `CapabilityGate whenOff="notice"`.
 * The API has no staff read of a membership's suspensions (only `GET /v1/me/memberships` for the
 * customer), so suspensions recorded before this page was opened are not listed; the ones made
 * here are shown with their state and can be ended. Membership benefits and terms are POL-038 and
 * DEC-007; nothing is computed here.
 */
import type { Schema } from '@sportspark/api-client';
import { useState } from 'react';
import { useApiCommand } from '../../api/useApiCommand';
import { Button } from '../../ui/Button';
import { CapabilityGate } from '../../ui/CapabilityGate';
import { StatusBadge } from '../../ui/StatusBadge';
import { CommandError, fieldErrorsOf } from './CommandError';
import { TextArea, TextField } from './fields';
import { formatInstant, localToInstant } from './format';
import { SUSPENSION_STATUS } from './labels';
import { OfflineCaption, useOnline } from './offline';

type Suspension = Schema<'MembershipSuspension'>;
type Enrollment = Schema<'Enrollment'>;

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
  const end = useApiCommand('post', '/membership-suspensions/{id}/end');
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
  const suspend = useApiCommand('post', '/enrollments/{id}/membership-suspensions');
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

export function MembershipSuspensionPanel({
  enrollment,
  zone,
}: {
  enrollment: Enrollment;
  zone: string | null;
}) {
  const [made, setMade] = useState<Suspension[]>([]);
  const replace = (next: Suspension) =>
    setMade((list) => list.map((s) => (s.id === next.id ? next : s)));
  return (
    <section className="rf-panel" aria-labelledby="suspensions-title">
      <h3 id="suspensions-title">Membership suspensions</h3>
      <CapabilityGate
        capability="memberships"
        whenOff="notice"
        stillAvailable="Suspending a membership and ending a suspension stay available: they are never turned off."
      >
        <p className="caption">
          Suspensions recorded earlier are not listed here: the API offers staff no read of a
          membership&apos;s suspensions. While a suspension is active, booking a session with this
          membership is refused (MEMBERSHIP_SUSPENDED).
        </p>
        {enrollment.status === 'confirmed' ? (
          <SuspendForm
            enrollment={enrollment}
            zone={zone}
            onSuspended={(s) => setMade((list) => [s, ...list])}
          />
        ) : (
          <p>Only a confirmed membership can be suspended.</p>
        )}
        {made.length > 0 ? (
          <ul className="list" aria-label="Suspensions recorded here">
            {made.map((s) => (
              <li key={s.id}>
                <div className="row-text">
                  <span>
                    <StatusBadge {...SUSPENSION_STATUS[s.status]} /> {formatInstant(s.from, zone)}{' '}
                    to {s.until ? formatInstant(s.until, zone) : 'until ended'}
                  </span>
                  <span className="caption">
                    {s.reason}
                    {s.endedAt
                      ? ` · ended ${formatInstant(s.endedAt, zone)}${s.endedReason ? `: ${s.endedReason}` : ''}`
                      : ''}
                  </span>
                </div>
                <EndSuspension suspension={s} zone={zone} onEnded={replace} />
              </li>
            ))}
          </ul>
        ) : null}
      </CapabilityGate>
    </section>
  );
}
