/**
 * SCR-S-02 Exception detail (SPK-UX-006, §4.9, SPK-UX-008). One operational exception from
 * `GET /v1/exceptions/{id}`: title, severity, status, affected record, owner queue, age, deadline,
 * next permitted actions and the resolution history.
 *
 * Acknowledge, resolve and close are offered only where the API lists them for the viewer (each
 * next action's `verb`, whether `exceptions.manage` or the queue owner's
 * `exceptions.manage_own_queue` authorizes it, SUP-01, K-10); each sends the exception's expected
 * revision and an idempotency key per intent; resolve and close need a note. Domain next actions
 * link to the owning module's staff screen. Closing never marks the underlying payment, booking or delivery resolved: the
 * affected record's own state is read from its owning module beside the exception (every record
 * type with a single-record read, `AffectedRecordState.tsx`) and a record in recovery says so.
 * Times are in the exception's facility zone (`GET /v1/facilities`, SPK-SCHED-008). The audit
 * history of the exception (`GET /v1/audit-records`) is offered to viewers who may read the audit
 * log. Offline the screen is read-only. A protected NOT_FOUND is shown as not available.
 */
import type { Schema } from '@sportspark/api-client';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { useApp } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { CommandError, CommandSuccess } from '../../ui/CommandFeedback';
import { Facts, TextAreaField } from '../../ui/FormFields';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { RecordRef, isUuid } from '../../ui/RecordRef';
import { StateView } from '../../ui/StateView';
import { StatusBadge, type StatusTone } from '../../ui/StatusBadge';
import { formatDateTime, formatMinutes } from '../../ui/time';
import {
  EXCEPTION_STATUS_TONE,
  RECOVERY_CATEGORIES,
  domainActions,
  permittedVerbs,
  type ExceptionVerb,
} from './exception-actions';
import { EXCEPTIONS_KEY, EXCEPTION_KEY, SEVERITY_BADGE, TODAY_KEY } from './TodayScreen';
import { AffectedRecordState } from './AffectedRecordState';
import { AuditHistory } from './AuditHistory';
import { NextActionLink } from './NextActionLink';
import { useFacilityDirectory } from './useFacilityDirectory';

type OperationalException = Schema<'OperationalException'>;

/** The affected record's own state, read from its owning module where the API offers a read. */
function AffectedRecord({ exception }: { exception: OperationalException }) {
  const affected = exception.affected;
  return (
    <section className="panel" aria-labelledby="affected-title">
      <h3 id="affected-title">Affected record</h3>
      {affected ? (
        <>
          <p>
            <RecordRef type={affected.type} id={affected.id} />
          </p>
          <AffectedRecordState type={affected.type} id={affected.id} />
        </>
      ) : (
        <p>No record is linked to this exception.</p>
      )}
      <p className="caption">
        Acknowledging, resolving or closing this exception never changes the affected record.
      </p>
    </section>
  );
}

const SUCCESS_TEXT: Record<ExceptionVerb, string> = {
  acknowledge: 'Exception acknowledged',
  resolve: 'Exception marked resolved',
  close: 'Exception closed',
};

function LifecycleCommands({ exception }: { exception: OperationalException }) {
  const { online } = useApp();
  const queryClient = useQueryClient();
  const verbs = permittedVerbs(exception.nextActions);
  const [note, setNote] = useState('');
  const [noteError, setNoteError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const invalidate = [EXCEPTION_KEY, EXCEPTIONS_KEY, TODAY_KEY];
  const acknowledge = useApiCommand('post', '/exceptions/{id}/acknowledge', { invalidate });
  const resolve = useApiCommand('post', '/exceptions/{id}/resolve', { invalidate });
  const close = useApiCommand('post', '/exceptions/{id}/close', { invalidate });
  const commands = { acknowledge, resolve, close };
  const busy = acknowledge.isProcessing || resolve.isProcessing || close.isProcessing;

  // STALE_REVISION or INVALID_TRANSITION: reload the current exception; the note is kept.
  const reload = () => {
    acknowledge.reset();
    resolve.reset();
    close.reset();
    void queryClient.invalidateQueries({ queryKey: EXCEPTION_KEY });
  };

  const run = (verb: ExceptionVerb) => {
    setSuccess(null);
    const trimmed = note.trim();
    if (verb !== 'acknowledge' && !trimmed) {
      setNoteError('Write what was done, so the resolution history explains it.');
      return;
    }
    setNoteError(null);
    const path = { id: exception.id };
    const done = (state: string) => {
      setSuccess(`${SUCCESS_TEXT[verb]}. State: ${state}.`);
      setNote('');
    };
    const promise =
      verb === 'acknowledge'
        ? acknowledge.submit({
            path,
            body: {
              expectedRevision: exception.revision,
              ...(trimmed ? { reason: trimmed } : {}),
            },
          })
        : commands[verb].submit({
            path,
            body: { expectedRevision: exception.revision, reason: trimmed },
          });
    void promise.then((r) => done(r.status)).catch(() => undefined);
  };

  if (verbs.size === 0) {
    return (
      <section className="panel" aria-labelledby="lifecycle-title">
        <h3 id="lifecycle-title">Workflow</h3>
        <CommandSuccess message={success} />
        <p>
          {exception.status === 'closed'
            ? 'This exception is closed.'
            : 'You can read this exception. Acknowledging, resolving and closing it are not available to you.'}
        </p>
      </section>
    );
  }

  return (
    <section className="panel" aria-labelledby="lifecycle-title">
      <h3 id="lifecycle-title">Workflow</h3>
      {!online ? (
        <p className="caption">Offline: this exception is read-only until you reconnect.</p>
      ) : null}
      {verbs.has('resolve') || verbs.has('close') ? (
        <TextAreaField
          label="Resolution note"
          hint="Needed to resolve or close. Say what was done; it is kept in the resolution history."
          value={note}
          onChange={setNote}
          error={noteError}
          maxLength={2000}
        />
      ) : null}
      <div className="actions-row">
        {verbs.has('acknowledge') ? (
          <Button
            busy={acknowledge.isProcessing}
            disabled={!online || busy}
            onClick={() => run('acknowledge')}
          >
            Acknowledge
          </Button>
        ) : null}
        {verbs.has('resolve') ? (
          <Button
            variant="secondary"
            busy={resolve.isProcessing}
            disabled={!online || busy}
            onClick={() => run('resolve')}
          >
            Mark resolved
          </Button>
        ) : null}
        {verbs.has('close') ? (
          <Button
            variant="secondary"
            busy={close.isProcessing}
            disabled={!online || busy}
            onClick={() => run('close')}
          >
            Close
          </Button>
        ) : null}
      </div>
      {verbs.has('close') ? (
        <p className="caption">
          Closing does not mark the affected payment, booking or delivery resolved.
        </p>
      ) : null}
      <CommandSuccess message={success} />
      <CommandError
        error={acknowledge.error}
        onRetry={() => run('acknowledge')}
        onReload={reload}
      />
      <CommandError error={resolve.error} onRetry={() => run('resolve')} onReload={reload} />
      <CommandError error={close.error} onRetry={() => run('close')} onReload={reload} />
    </section>
  );
}

function ExceptionView({ exception }: { exception: OperationalException }) {
  const facilities = useFacilityDirectory();
  const zone = facilities.timezone(exception.facilityId);
  const severity = SEVERITY_BADGE[exception.severity];
  const next = domainActions(exception.nextActions);
  const recovery = RECOVERY_CATEGORIES.has(exception.category);
  const statusTone: StatusTone = EXCEPTION_STATUS_TONE[exception.status];
  return (
    <>
      <h3>{exception.title}</h3>
      <span className="actions-row">
        {recovery ? <StatusBadge tone="danger" label="Recovery required" /> : null}
        <StatusBadge tone={severity.tone} label={severity.label} />
        <StatusBadge tone={statusTone} label={`Status: ${exception.status}`} />
        {exception.overdue ? <StatusBadge tone="danger" label="Overdue" /> : null}
      </span>
      <Facts
        label="Exception details"
        items={[
          ['Category', exception.category],
          ['Owner queue', exception.ownerQueue],
          ['Facility', facilities.name(exception.facilityId) ?? 'Whole organization'],
          ['Opened', formatDateTime(exception.openedAt, zone)],
          ['Age', formatMinutes(exception.ageMinutes)],
          [
            'Acknowledge by',
            exception.acknowledgeBy ? formatDateTime(exception.acknowledgeBy, zone) : 'None set',
          ],
          ['Deadline', exception.deadlineAt ? formatDateTime(exception.deadlineAt, zone) : 'None'],
          ['Revision', String(exception.revision)],
        ]}
      />
      <AffectedRecord exception={exception} />
      <section className="panel" aria-labelledby="next-title">
        <h3 id="next-title">Next permitted actions</h3>
        {next.length === 0 ? (
          <p>No action on the underlying record is available to you.</p>
        ) : (
          <ul className="list">
            {next.map((a) => (
              <li key={`${a.action}-${a.href ?? ''}`}>
                <NextActionLink action={a} />
                <span className="caption">{a.action}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <LifecycleCommands exception={exception} />
      <section className="panel" aria-labelledby="history-title">
        <h3 id="history-title">Resolution history</h3>
        <ol aria-label="Resolution history">
          {exception.history.map((h, i) => (
            <li key={`${h.at}-${i}`}>
              {formatDateTime(h.at, zone)}: {h.action} by {h.actorLabel}
              {h.reason ? `. Note: ${h.reason}` : ''}
            </li>
          ))}
        </ol>
      </section>
      <AuditHistory targetType="operational_exception" targetId={exception.id} zone={zone} />
    </>
  );
}

function ExceptionQuery({ id }: { id: string }) {
  const exception = useApiQuery({ path: '/exceptions/{id}', request: { path: { id } } });
  return (
    <QueryBoundary
      query={exception}
      label="the exception"
      empty={{ title: '', description: '' }}
      unavailableOffline={['acknowledging, resolving and closing']}
    >
      {(data) => <ExceptionView exception={data} />}
    </QueryBoundary>
  );
}

export function ExceptionDetailScreen() {
  const { exceptionId = '' } = useParams();
  return (
    <section aria-labelledby="exception-title">
      <p>
        <Link to="/today">Back to Today</Link>
      </p>
      <h2 id="exception-title">Exception</h2>
      {isUuid(exceptionId) ? (
        <ExceptionQuery id={exceptionId} />
      ) : (
        <StateView variant="unavailable" />
      )}
    </section>
  );
}
